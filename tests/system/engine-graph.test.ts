import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { RUN_FAILED, seedWorkflow } from "@tabductor/engine";
import { runs } from "@tabductor/db";
import {
  allRuns,
  eventsOfType,
  runsForTask,
  startRig,
  trigger,
  waitFor,
  waitForQuiet,
  type Rig,
} from "./engine-support.js";

let rig: Rig;

afterEach(async () => {
  await rig?.stop();
});

it("runs a linear chain A→B→C, carrying each packet and its causation forward", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      A: { stub: { emits: [{ type: "a.done", packet: { from: "A", n: 1 } }] } },
      B: { stub: { emits: [{ type: "b.done", packet: { from: "B", n: 2 } }] } },
      C: {},
    },
    edges: [
      ["Start", "chain.start", "A"],
      ["A", "a.done", "B"],
      ["B", "b.done", "C"],
    ],
  });

  // The entry event is attributed to `Start`, the way a schedule fire will be in S2b.
  const start = await trigger(rig, wf.taskIds.Start!, "chain.start");
  await waitForQuiet(rig);

  const [runA] = await runsForTask(rig, wf.taskIds.A!);
  const [runB] = await runsForTask(rig, wf.taskIds.B!);
  const [runC] = await runsForTask(rig, wf.taskIds.C!);

  expect(runA?.status).toBe("succeeded");
  expect(runB?.status).toBe("succeeded");
  expect(runC?.status).toBe("succeeded");

  // Each run pins the version it started under.
  expect([runA, runB, runC].map((r) => r!.workflowVersionId)).toEqual([
    wf.versionId,
    wf.versionId,
    wf.versionId,
  ]);

  // B's trigger is A's emitted event, and A's packet is visible on it.
  const [aDone] = await eventsOfType(rig, "a.done");
  expect(runB!.triggerEventId).toBe(aDone!.eventId);
  expect(aDone!.packet).toEqual({ from: "A", n: 1 });
  expect(aDone!.sourceRunId).toBe(runA!.id);

  const [bDone] = await eventsOfType(rig, "b.done");
  expect(runC!.triggerEventId).toBe(bDone!.eventId);
  expect(bDone!.packet).toEqual({ from: "B", n: 2 });

  // Lineage: chain.start → a.done → b.done, each caused by the previous.
  expect(aDone!.causationId).toBe(start.eventId);
  expect(bDone!.causationId).toBe(aDone!.eventId);
});

it("fans one event out to three tasks; a failing sibling does not disturb the others", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Source: {},
      Ok1: {},
      Ok2: {},
      Boom: { stub: { fail: "stub asked to fail" } },
    },
    edges: [
      ["Source", "fan.out", "Ok1"],
      ["Source", "fan.out", "Ok2"],
      ["Source", "fan.out", "Boom"],
    ],
  });

  await trigger(rig, wf.taskIds.Source!, "fan.out", { hello: "all" });
  await waitForQuiet(rig);

  const created = await allRuns(rig);
  expect(created).toHaveLength(3);

  const [ok1] = await runsForTask(rig, wf.taskIds.Ok1!);
  const [ok2] = await runsForTask(rig, wf.taskIds.Ok2!);
  const [boom] = await runsForTask(rig, wf.taskIds.Boom!);

  expect(ok1!.status).toBe("succeeded");
  expect(ok2!.status).toBe("succeeded");
  expect(boom!.status).toBe("failed");
  expect(boom!.error).toContain("stub asked to fail");

  // The failure is announced as a subscribable system event (§6).
  const failures = await eventsOfType(rig, RUN_FAILED);
  expect(failures).toHaveLength(1);
  expect(failures[0]!.sourceRunId).toBe(boom!.id);
  expect(failures[0]!.packet).toMatchObject({ runId: boom!.id, error: "stub asked to fail" });
});

it("routes new events against the latest version while an in-flight run stays pinned to its own", async () => {
  rig = await startRig();

  // v1: A→B. A's stub dawdles so the graph can be edited while its run is still going.
  const v1 = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      A: { stub: { emits: [{ type: "a.done", packet: { v: 1 }, delay_ms: 400 }] } },
      B: {},
    },
    edges: [
      ["Start", "chain.start", "A"],
      ["A", "a.done", "B"],
    ],
  });

  await trigger(rig, v1.taskIds.Start!, "chain.start");
  const inFlight = await waitFor("A's run to start", async () => {
    const [row] = await runsForTask(rig, v1.taskIds.A!);
    return row?.status === "running" ? row : false;
  });
  expect(inFlight.workflowVersionId).toBe(v1.versionId);

  // v2 of the same workflow: same node A, but its event now routes to C instead of B.
  const v2 = await seedWorkflow(rig.handle.db, {
    workflowId: v1.workflowId,
    tasks: {
      Start: {},
      A: { stub: { emits: [{ type: "a.done", packet: { v: 1 }, delay_ms: 400 }] } },
      B: {},
      C: {},
    },
    edges: [
      ["Start", "chain.start", "A"],
      ["A", "a.done", "C"],
    ],
  });
  expect(v2.versionId).not.toBe(v1.versionId);

  await waitForQuiet(rig);

  // The in-flight run finished under v1, untouched by the edit.
  const [runA] = await runsForTask(rig, v1.taskIds.A!);
  expect(runA!.status).toBe("succeeded");
  expect(runA!.workflowVersionId).toBe(v1.versionId);

  // Its emitted event routed per v2: C ran, B did not.
  const [runC] = await runsForTask(rig, v2.taskIds.C!);
  expect(runC?.status).toBe("succeeded");
  expect(runC!.workflowVersionId).toBe(v2.versionId);

  expect(await runsForTask(rig, v1.taskIds.B!)).toHaveLength(0);
  expect(await runsForTask(rig, v2.taskIds.B!)).toHaveLength(0);

  // And nothing ran twice.
  expect(await rig.handle.db.select().from(runs).where(eq(runs.status, "succeeded"))).toHaveLength(2);
});
