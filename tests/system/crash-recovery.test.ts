import { afterEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { newId } from "@tabductor/core";
import { runs } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { ENGINE_RESTART, RUN_FAILED, seedWorkflow } from "@tabductor/engine";
import {
  eventsOfType,
  runsForTask,
  startRig,
  trigger,
  waitFor,
  type Rig,
} from "./engine-support.js";

let rig: Rig;
let handle: MigratedTestDb | undefined;

afterEach(async () => {
  await rig?.stop();
  await handle?.close();
  handle = undefined;
});

/**
 * Crash recovery (§15). A process that dies mid-run leaves the row `running` forever: no
 * executor will ever finish it and, without a deadline, no watchdog will ever reap it. What
 * gives it away is the heartbeat — it stopped ticking. On boot, anything quiet for longer
 * than the stale window is declared `failed(engine_restart)` and put through the retry
 * policy, because the design says re-run from the start rather than resume mid-page.
 */
it("fails a run abandoned by a dead process and retries it per policy", async () => {
  handle = await createMigratedTestDb();
  const wf = await seedWorkflow(handle.db, {
    tasks: { Worker: { retry: { max: 1, backoff_ms: 10 } } },
  });

  // The wreckage a crashed engine leaves: `running`, heartbeat long stale, no deadline.
  const abandonedId = newId("run");
  const triggerEvent = await trigger({ handle }, wf.taskIds.Worker!, "work.requested");
  await handle.db.insert(runs).values({
    id: abandonedId,
    taskId: wf.taskIds.Worker!,
    workflowVersionId: wf.versionId,
    triggerEventId: triggerEvent.eventId,
    status: "running",
    modeUsed: "stub",
    startedAt: sql`now() - interval '10 minutes'`,
    heartbeatAt: sql`now() - interval '10 minutes'`,
  });

  rig = await startRig({ handle, staleHeartbeatMs: 1_000 });

  const recovered = await waitFor("the abandoned run to be recovered", async () => {
    const [row] = await handle!.db.select().from(runs).where(eq(runs.id, abandonedId));
    return row?.status === "failed" ? row : false;
  });
  expect(recovered.error).toBe(ENGINE_RESTART);
  expect(recovered.endedAt).not.toBeNull();

  // The retry policy applied to it: a second attempt, same trigger, and it ran.
  const attempts = await waitFor("the recovered run to be retried", async () => {
    const rows = await runsForTask(rig, wf.taskIds.Worker!);
    return rows.length === 2 && rows[1]!.status === "succeeded" ? rows : false;
  });
  expect(attempts[1]!.attempt).toBe(1);
  expect(attempts[1]!.triggerEventId).toBe(triggerEvent.eventId);

  // The recovery is a real failure, so it announces itself like any other.
  const failed = await eventsOfType(rig, RUN_FAILED);
  expect(failed).toHaveLength(1);
  expect(failed[0]!.packet).toMatchObject({ runId: abandonedId, error: ENGINE_RESTART });
});

/**
 * The stale window must be a window, not a status check. A run that this engine is actively
 * executing is `running` too, and recovering it out from under its own executor would fail
 * a run that is doing fine.
 */
it("leaves a live run alone: its heartbeat keeps ticking while it works", async () => {
  rig = await startRig({ heartbeatIntervalMs: 30, staleHeartbeatMs: 60_000 });
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Start: {}, Slow: { stub: { hang_ms: 30_000 } } },
    edges: [["Start", "work.requested", "Slow"]],
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");
  const started = await waitFor("the slow run to start", async () => {
    const [row] = await runsForTask(rig, wf.taskIds.Slow!);
    return row?.status === "running" && row.heartbeatAt ? row : false;
  });

  // The heartbeat advances past where it was stamped at start — the run is proving liveness.
  const beating = await waitFor("the heartbeat to advance", async () => {
    const [row] = await runsForTask(rig, wf.taskIds.Slow!);
    return row && row.heartbeatAt!.getTime() > started.heartbeatAt!.getTime() ? row : false;
  });
  expect(beating.status).toBe("running");
});

/**
 * Recovery runs before the engine takes any new work, so a run picked up moments earlier by
 * *this* process is never mistaken for one the previous process abandoned.
 */
it("does not recover a run younger than the stale window", async () => {
  handle = await createMigratedTestDb();
  const wf = await seedWorkflow(handle.db, {
    tasks: { Worker: {}, Start: {}, Other: {} },
    edges: [["Start", "other.requested", "Other"]],
  });

  const youngId = newId("run");
  await handle.db.insert(runs).values({
    id: youngId,
    taskId: wf.taskIds.Worker!,
    workflowVersionId: wf.versionId,
    status: "running",
    modeUsed: "stub",
    startedAt: sql`now()`,
    heartbeatAt: sql`now()`,
  });

  rig = await startRig({ handle, staleHeartbeatMs: 60_000 });

  // The assertion is an absence, so give it something to be absent *against*: an unrelated
  // run driven all the way through proves the engine was awake and working the whole time.
  await trigger(rig, wf.taskIds.Start!, "other.requested");
  await waitFor("an unrelated run to complete", async () => {
    const rows = await runsForTask(rig, wf.taskIds.Other!);
    return rows.length === 0 ? false : rows.every((r) => r.status === "succeeded");
  });

  const [row] = await handle.db.select().from(runs).where(eq(runs.id, youngId));
  expect(row!.status).toBe("running");
  expect(await eventsOfType(rig, RUN_FAILED)).toHaveLength(0);
});
