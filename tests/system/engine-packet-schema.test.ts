import { afterEach, expect, it } from "vitest";
import { RUN_FAILED, seedWorkflow } from "@tabductor/engine";
import { allRuns, eventsOfType, runsForTask, startRig, trigger, waitForQuiet, type Rig } from "./engine-support.js";

let rig: Rig;

afterEach(async () => {
  await rig?.stop();
});

/**
 * §4: "a packet that fails validation should fail the emit (and surface in the run log)
 * rather than silently propagating malformed data". The blast radius is the emitting run —
 * nothing downstream should observe the bad packet at all.
 */
it("rejects an emit whose packet violates the declared schema and fails only that run", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      A: {
        // Declares `tweet.detected` as needing a string `url`; the stub emits without one.
        emits: {
          "tweet.detected": {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
        stub: { emits: [{ type: "tweet.detected", packet: { text: "no url here" } }] },
      },
      B: {},
    },
    edges: [
      ["Start", "schema.start", "A"],
      ["A", "tweet.detected", "B"],
    ],
  });

  await trigger(rig, wf.taskIds.Start!, "schema.start");
  await waitForQuiet(rig);

  const [runA] = await runsForTask(rig, wf.taskIds.A!);
  expect(runA!.status).toBe("failed");
  expect(runA!.error).toContain("tweet.detected");
  expect(runA!.error).toContain("url");

  // The malformed event was never published, so B never heard of it.
  expect(await eventsOfType(rig, "tweet.detected")).toHaveLength(0);
  expect(await runsForTask(rig, wf.taskIds.B!)).toHaveLength(0);
  expect(await allRuns(rig)).toHaveLength(1);

  const failures = await eventsOfType(rig, RUN_FAILED);
  expect(failures).toHaveLength(1);
  expect(failures[0]!.sourceRunId).toBe(runA!.id);
});

it("accepts a packet that satisfies the schema", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      A: {
        emits: {
          "tweet.detected": {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
        stub: { emits: [{ type: "tweet.detected", packet: { url: "https://x.com/1" } }] },
      },
      B: {},
    },
    edges: [
      ["Start", "schema.start", "A"],
      ["A", "tweet.detected", "B"],
    ],
  });

  await trigger(rig, wf.taskIds.Start!, "schema.start");
  await waitForQuiet(rig);

  const [runA] = await runsForTask(rig, wf.taskIds.A!);
  const [runB] = await runsForTask(rig, wf.taskIds.B!);
  expect(runA!.status).toBe("succeeded");
  expect(runB?.status).toBe("succeeded");
  expect((await eventsOfType(rig, "tweet.detected"))[0]!.packet).toEqual({ url: "https://x.com/1" });
});
