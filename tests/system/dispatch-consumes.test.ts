import { expect, it, afterEach } from "vitest";
import { runs, tasks } from "@tabductor/db";
import { seedWorkflow, triggerTask } from "@tabductor/engine";
import { eq, inArray } from "drizzle-orm";
import { startRig, waitForQuiet, type Rig } from "./engine-support.js";

/**
 * The semantic heart of the event-centric model: routing is by *type*, not by emitter.
 * An event of type T reaches every consumer of T in the workflow, whichever task produced
 * it — including a second emitter added later, and including scriptless tasks whose
 * emits are derived from the compiled schema.
 */

let rig: Rig;

afterEach(async () => {
  await rig?.stop();
});

it("fans an event type out to every consumer, from any emitter", async () => {
  rig = await startRig();
  const db = rig.handle.db;

  const wf = await seedWorkflow(db, {
    tasks: {
      // Two independent emitters of the same type…
      Watcher: { stub: { emits: [{ type: "tweet.detected", packet: { url: "https://x.test/1" } }] } },
      Backfiller: { stub: { emits: [{ type: "tweet.detected", packet: { url: "https://x.test/2" } }] } },
      // …and two consumers, subscribed by type alone.
      Scorer: { consumes: ["tweet.detected"] },
      Archiver: { consumes: ["tweet.detected"] },
    },
  });

  await triggerTask(db, { taskId: wf.taskIds.Watcher! });
  await triggerTask(db, { taskId: wf.taskIds.Backfiller! });
  await waitForQuiet(rig);

  // 2 emitter runs (manual) + each of 2 events reaching both consumers = 4 consumer runs.
  const consumerIds = [wf.taskIds.Scorer!, wf.taskIds.Archiver!];
  const consumerRuns = await db.select().from(runs).where(inArray(runs.taskId, consumerIds));
  expect(consumerRuns).toHaveLength(4);
  expect(consumerRuns.every((r) => r.status === "succeeded")).toBe(true);
});

it("lets a scriptless task emit valid samples derived from its compiled schema", async () => {
  rig = await startRig();
  const db = rig.handle.db;

  const wf = await seedWorkflow(db, {
    tasks: {
      // No stub script at all — behavior is derived from the declared emit's schema.
      Detector: { emits: ["thing.found"] },
      Sink: { consumes: ["thing.found"] },
    },
    events: {
      "thing.found": {
        schema: {
          type: "object",
          properties: { url: { type: "string", format: "uri" }, seen: { type: "boolean" } },
          required: ["url", "seen"],
          additionalProperties: false,
        },
      },
    },
  });

  await triggerTask(db, { taskId: wf.taskIds.Detector! });
  await waitForQuiet(rig);

  // The derived packet validated against the schema (the emit path enforces it), and the
  // consumer ran on it.
  const [sinkRun] = await db.select().from(runs).where(eq(runs.taskId, wf.taskIds.Sink!));
  expect(sinkRun?.status).toBe("succeeded");
  const [detectorRun] = await db
    .select({ run: runs, task: tasks })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.taskId, wf.taskIds.Detector!));
  expect(detectorRun?.run.status).toBe("succeeded");
});
