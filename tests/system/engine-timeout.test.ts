import { afterEach, expect, it } from "vitest";
import { RUN_TIMED_OUT, seedWorkflow } from "@tabductor/engine";
import { eventsOfType, runsForTask, startRig, trigger, waitFor, type Rig } from "./engine-support.js";

let rig: Rig;

afterEach(async () => {
  await rig?.stop();
});

/**
 * The watchdog reads the deadline off the run row rather than holding a `setTimeout`, so
 * the timeout is a property of the database, not of the process that started the run (§15).
 */
it("times out a hanging run and publishes run.timed_out", async () => {
  rig = await startRig({ watchdogIntervalMs: 50 });
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Hang: { runTimeoutMs: 200, stub: { hang_ms: 30_000 } },
    },
    edges: [["Start", "hang.start", "Hang"]],
  });

  await trigger(rig, wf.taskIds.Start!, "hang.start");

  const timedOut = await waitFor("the hanging run to be reaped", async () => {
    const [row] = await runsForTask(rig, wf.taskIds.Hang!);
    return row?.status === "timed_out" ? row : false;
  });

  expect(timedOut.error).toContain("timeout");
  expect(timedOut.endedAt).not.toBeNull();
  expect(timedOut.deadlineAt).not.toBeNull();
  // The deadline was stamped from the task limit, not invented by the watchdog.
  expect(timedOut.deadlineAt!.getTime() - timedOut.startedAt!.getTime()).toBeCloseTo(200, -2);

  const events = await eventsOfType(rig, RUN_TIMED_OUT);
  expect(events).toHaveLength(1);
  expect(events[0]!.sourceRunId).toBe(timedOut.id);
  expect(events[0]!.packet).toMatchObject({ runId: timedOut.id, taskId: wf.taskIds.Hang });
});

/**
 * The executor is still hanging when the watchdog reaps the run. Whatever it eventually
 * returns must not resurrect a run that is already terminal — first writer wins.
 */
it("keeps the run terminal when the hanging executor finally returns", async () => {
  rig = await startRig({ watchdogIntervalMs: 50 });
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Hang: { runTimeoutMs: 150, stub: { hang_ms: 600 } },
    },
    edges: [["Start", "hang.start", "Hang"]],
  });

  await trigger(rig, wf.taskIds.Start!, "hang.start");
  const timedOut = await waitFor("the run to time out", async () => {
    const [row] = await runsForTask(rig, wf.taskIds.Hang!);
    return row?.status === "timed_out" ? row : false;
  });

  // Outlive the stub's hang, then prove the status never moved.
  await waitFor("the stub to finish hanging", async () => Date.now() > timedOut.endedAt!.getTime() + 900);
  const [row] = await runsForTask(rig, wf.taskIds.Hang!);
  expect(row!.status).toBe("timed_out");
  expect(await eventsOfType(rig, RUN_TIMED_OUT)).toHaveLength(1);
  expect(await eventsOfType(rig, "run.completed")).toHaveLength(0);
});
