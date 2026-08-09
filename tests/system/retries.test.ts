import { afterEach, expect, it } from "vitest";
import { RETRIES_EXHAUSTED, RUN_FAILED, seedWorkflow } from "@tabductor/engine";
import {
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

/**
 * Retry policy (§15). A retry is a *new run row* at attempt n+1 carrying the same
 * `trigger_event_id` — the history of what was tried stays visible, and the trigger is not
 * re-emitted. That reuse is also why retries must bypass the dedupe claim: the claim for
 * this `(task, event)` was taken by attempt 0 and is still held.
 */
it("retries a failing run until it succeeds, reusing the trigger event", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Flaky: {
        retry: { max: 3, backoff_ms: 50 },
        stub: { fail_times: 2, emits: [{ type: "flaky.done" }] },
      },
      Downstream: {},
    },
    edges: [
      ["Start", "work.requested", "Flaky"],
      ["Flaky", "flaky.done", "Downstream"],
    ],
  });

  const start = await trigger(rig, wf.taskIds.Start!, "work.requested");

  // Wait for the attempt that succeeds, not for the graph to look quiet: between a failure
  // committing and its retry being inserted there is an instant where every run is terminal
  // and the outbox is empty, and "quiet" would believe it.
  const attempts = await waitFor("the third attempt to succeed", async () => {
    const rows = await runsForTask(rig, wf.taskIds.Flaky!);
    return rows.length === 3 && rows[2]!.status === "succeeded" ? rows : false;
  });
  await waitForQuiet(rig);
  expect(attempts).toHaveLength(3);
  expect(attempts.map((r) => r.attempt)).toEqual([0, 1, 2]);
  expect(attempts.map((r) => r.status)).toEqual(["failed", "failed", "succeeded"]);

  // One trigger event for all three attempts, and exactly one dedupe claim behind them.
  expect(new Set(attempts.map((r) => r.triggerEventId))).toEqual(new Set([start.eventId]));

  // Backoff is a column, not a sleep: assert the ordering the engine actually honors,
  // which is what makes this test immune to how fast the machine happens to be.
  expect(attempts[0]!.notBefore).toBeNull();
  expect(attempts[1]!.notBefore!.getTime()).toBeGreaterThan(attempts[0]!.endedAt!.getTime());
  expect(attempts[2]!.notBefore!.getTime()).toBeGreaterThan(attempts[1]!.endedAt!.getTime());
  // ...and it grows per attempt (50ms then 100ms), rather than staying flat.
  const first = attempts[1]!.notBefore!.getTime() - attempts[0]!.endedAt!.getTime();
  const second = attempts[2]!.notBefore!.getTime() - attempts[1]!.endedAt!.getTime();
  expect(second).toBeGreaterThan(first);

  // The delay was really taken, not just recorded.
  expect(attempts[1]!.startedAt!.getTime()).toBeGreaterThanOrEqual(attempts[1]!.notBefore!.getTime());

  // A failure per attempt; the downstream fired once, from the attempt that worked.
  expect(await eventsOfType(rig, RUN_FAILED)).toHaveLength(2);
  expect(await eventsOfType(rig, "flaky.done")).toHaveLength(1);
  expect(await runsForTask(rig, wf.taskIds.Downstream!)).toHaveLength(1);
  expect(await eventsOfType(rig, RETRIES_EXHAUSTED)).toHaveLength(0);
});

/** A policy that runs out announces it, so an error-handling workflow can subscribe. */
it("publishes system.retries_exhausted after the last attempt fails", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Doomed: { retry: { max: 2, backoff_ms: 10 }, stub: { fail: "always broken" } },
    },
    edges: [["Start", "work.requested", "Doomed"]],
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");

  // The exhaustion notice is published only after the last attempt has failed, so it is
  // itself the signal that the whole policy has played out.
  const exhausted = await waitFor("the retry policy to run out", async () => {
    const [row] = await eventsOfType(rig, RETRIES_EXHAUSTED);
    return row ?? false;
  });
  await waitForQuiet(rig);

  const attempts = await runsForTask(rig, wf.taskIds.Doomed!);
  expect(attempts).toHaveLength(3); // the original plus max=2 retries
  expect(attempts.every((r) => r.status === "failed")).toBe(true);
  expect(await eventsOfType(rig, RUN_FAILED)).toHaveLength(3);
  expect(await eventsOfType(rig, RETRIES_EXHAUSTED)).toHaveLength(1);
  expect(exhausted.packet).toMatchObject({
    taskId: wf.taskIds.Doomed,
    attempts: 3,
    max: 2,
    error: "always broken",
  });
});

/** No policy on the task means the pre-S2b behavior: one attempt, no announcement. */
it("does not retry a task with no retry policy", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Start: {}, Doomed: { stub: { fail: "broken" } } },
    edges: [["Start", "work.requested", "Doomed"]],
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");
  await waitFor("the run to fail", async () => {
    const [row] = await runsForTask(rig, wf.taskIds.Doomed!);
    return row?.status === "failed";
  });
  await waitForQuiet(rig);

  expect(await runsForTask(rig, wf.taskIds.Doomed!)).toHaveLength(1);
  expect(await eventsOfType(rig, RETRIES_EXHAUSTED)).toHaveLength(0);
});

/**
 * A permanent failure is not a fault to be re-tried but a verdict: a packet that failed
 * validation will fail it again, and a policy denial (Phase 7) is a decision. The retry
 * policy is present and still does not fire.
 */
it("does not retry a failure the executor marked permanent", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Denied: { retry: { max: 3, backoff_ms: 10 }, stub: { permanent_fail: "policy denied" } },
    },
    edges: [["Start", "work.requested", "Denied"]],
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");
  await waitFor("the run to fail", async () => {
    const [row] = await runsForTask(rig, wf.taskIds.Denied!);
    return row?.status === "failed";
  });
  await waitForQuiet(rig);

  const attempts = await runsForTask(rig, wf.taskIds.Denied!);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.error).toBe("policy denied");
  expect(await eventsOfType(rig, RETRIES_EXHAUSTED)).toHaveLength(0);
});
