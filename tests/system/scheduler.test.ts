import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SCHEDULE_FIRED, SCHEDULE_SKIPPED, seedSchedule, seedWorkflow } from "@tabductor/engine";
import { schedules } from "@tabductor/db";
import {
  eventsOfType,
  runsForTask,
  startRig,
  waitFor,
  type Rig,
} from "./engine-support.js";

let rig: Rig;

afterEach(async () => {
  await rig?.stop();
});

const EVERY_SECOND = "* * * * * *";

/**
 * A schedule is an event source and nothing more (§7): the fire is an ordinary event on the
 * outbox, and the run behind it is created by the ordinary dispatch path. What makes it
 * unusual is that there is no edge — the schedule names its task, so dispatch has to target
 * that task directly, which is the one thing these tests are really pinning down.
 */
it("fires a cron schedule repeatedly, each fire producing an event and a run", async () => {
  rig = await startRig({ scheduler: { tickMs: 25 } });
  const wf = await seedWorkflow(rig.handle.db, { tasks: { Cronned: {} } });
  await seedSchedule(rig.handle.db, { taskId: wf.taskIds.Cronned!, cron: EVERY_SECOND });

  const runs = await waitFor("two scheduled fires", async () => {
    const rows = await runsForTask(rig, wf.taskIds.Cronned!);
    return rows.length >= 2 ? rows : false;
  });

  const fires = await eventsOfType(rig, SCHEDULE_FIRED);
  expect(fires.length).toBeGreaterThanOrEqual(2);

  // Every fire is a fresh chain head: empty packet, no causation, attributed to the task.
  for (const fire of fires) {
    expect(fire.packet).toEqual({});
    expect(fire.causationId).toBeNull();
    expect(fire.sourceTaskId).toBe(wf.taskIds.Cronned);
  }

  // Each run is pinned to its own fire — not two runs sharing one trigger.
  const triggers = new Set(runs.map((r) => r.triggerEventId));
  expect(triggers.size).toBe(runs.length);
  for (const run of runs) {
    expect(fires.some((f) => f.eventId === run.triggerEventId)).toBe(true);
  }

  // The row is the source of truth, so the fire is recorded there too.
  const [row] = await rig.handle.db.select().from(schedules).where(eq(schedules.taskId, wf.taskIds.Cronned!));
  expect(row!.lastFiredAt).not.toBeNull();
});

/**
 * Overlap `skip` (§7): overlapping browser runs against one CDP session are a correctness
 * hazard, so a fire that lands on a task already working is dropped outright. The drop is
 * recorded as an event rather than swallowed — a schedule that silently stops firing is
 * indistinguishable from a broken one.
 */
it("drops fires that overlap a live run and records each as system.schedule_skipped", async () => {
  rig = await startRig({ scheduler: { tickMs: 25 } });
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Slow: { stub: { hang_ms: 30_000 } } },
  });
  await seedSchedule(rig.handle.db, {
    taskId: wf.taskIds.Slow!,
    cron: EVERY_SECOND,
    overlapPolicy: "skip",
  });

  await waitFor("two fires to have been skipped", async () => {
    const skipped = await eventsOfType(rig, SCHEDULE_SKIPPED);
    return skipped.length >= 2 ? skipped : false;
  });

  // The one long run is still the only run there has ever been.
  const rows = await runsForTask(rig, wf.taskIds.Slow!);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("running");

  const skipped = await eventsOfType(rig, SCHEDULE_SKIPPED);
  expect(skipped[0]!.packet).toMatchObject({ taskId: wf.taskIds.Slow, policy: "skip", liveRuns: 1 });
});

/**
 * Overlap `queue` allows exactly one fire to wait behind the live one — depth 1, not a
 * backlog. Anything past that is dropped like `skip` would drop it.
 */
it("queues at most one run behind the live one under overlap policy queue", async () => {
  rig = await startRig({ scheduler: { tickMs: 25 } });
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Slow: { stub: { hang_ms: 30_000 } } },
  });
  await seedSchedule(rig.handle.db, {
    taskId: wf.taskIds.Slow!,
    cron: EVERY_SECOND,
    overlapPolicy: "queue",
  });

  await waitFor("the queue to fill and a further fire to be dropped", async () => {
    const skipped = await eventsOfType(rig, SCHEDULE_SKIPPED);
    return skipped.length >= 1;
  });

  const rows = await runsForTask(rig, wf.taskIds.Slow!);
  expect(rows.filter((r) => r.status === "running")).toHaveLength(1);
  expect(rows.filter((r) => r.status === "queued")).toHaveLength(1);
  expect(rows).toHaveLength(2);

  // Give the scheduler several more ticks; the depth must not creep past 2.
  await waitFor("three more fires to be dropped", async () => {
    const skipped = await eventsOfType(rig, SCHEDULE_SKIPPED);
    return skipped.length >= 3;
  });
  expect(await runsForTask(rig, wf.taskIds.Slow!)).toHaveLength(2);

  const skipped = await eventsOfType(rig, SCHEDULE_SKIPPED);
  expect(skipped[0]!.packet).toMatchObject({ policy: "queue", liveRuns: 2 });
});

/**
 * Missed-fire `skip` (§7): the engine was down over many ticks. Never replay a backlog
 * against a live website — the downtime is forgotten and `last_fired_at` is moved to now.
 *
 * The clock is faked rather than waited on, which is what makes "ten minutes of downtime"
 * a test that finishes instantly.
 */
it("skips every fire missed while the engine was down, under missed policy skip", async () => {
  const at = Date.UTC(2030, 0, 1, 12, 0, 0);
  rig = await startRig({ scheduler: { tickMs: 10_000, now: () => at } });
  const wf = await seedWorkflow(rig.handle.db, { tasks: { Cronned: {} } });
  const sched = await seedSchedule(rig.handle.db, {
    taskId: wf.taskIds.Cronned!,
    // Hourly, so the "next tick" the missed-fire policy would otherwise catch up on is
    // unambiguously in the past and no live tick can confuse the assertion.
    cron: "0 * * * *",
    missedPolicy: "skip",
    lastFiredAt: new Date(at - 10 * 60_000),
  });

  await rig.engine.scheduler!.tick();
  await rig.engine.scheduler!.tick();

  expect(await runsForTask(rig, wf.taskIds.Cronned!)).toHaveLength(0);
  expect(await eventsOfType(rig, SCHEDULE_FIRED)).toHaveLength(0);

  // The downtime was dropped, not deferred: the schedule now starts from "now".
  const [row] = await rig.handle.db.select().from(schedules).where(eq(schedules.id, sched.id));
  expect(row!.lastFiredAt!.getTime()).toBe(at);
});

/** `fire_once_catchup` fires exactly one event, no matter how many ticks were missed. */
it("fires exactly once for a long outage under missed policy fire_once_catchup", async () => {
  const at = Date.UTC(2030, 0, 1, 12, 0, 0);
  rig = await startRig({ scheduler: { tickMs: 10_000, now: () => at } });
  const wf = await seedWorkflow(rig.handle.db, { tasks: { Cronned: {} } });
  await seedSchedule(rig.handle.db, {
    taskId: wf.taskIds.Cronned!,
    // Every minute: ten minutes of downtime is ten missed ticks, and still one fire.
    cron: "* * * * *",
    missedPolicy: "fire_once_catchup",
    lastFiredAt: new Date(at - 10 * 60_000),
  });

  await rig.engine.scheduler!.tick();
  await rig.engine.scheduler!.tick();
  await rig.engine.scheduler!.tick();

  expect(await eventsOfType(rig, SCHEDULE_FIRED)).toHaveLength(1);
  await waitFor("the caught-up fire to produce its run", async () => {
    const rows = await runsForTask(rig, wf.taskIds.Cronned!);
    return rows.length === 1 && rows[0]!.status === "succeeded";
  });
});

/** A disabled schedule is inert; the scheduler never reads past `enabled`. */
it("never fires a disabled schedule", async () => {
  rig = await startRig({ scheduler: { tickMs: 25 } });
  const wf = await seedWorkflow(rig.handle.db, { tasks: { Off: {}, On: {} } });
  await seedSchedule(rig.handle.db, { taskId: wf.taskIds.Off!, cron: EVERY_SECOND, enabled: false });
  await seedSchedule(rig.handle.db, { taskId: wf.taskIds.On!, cron: EVERY_SECOND });

  // The enabled sibling is the clock: once it has fired twice, the disabled one has had
  // every chance to fire and demonstrably did not.
  await waitFor("the enabled schedule to fire twice", async () => {
    const rows = await runsForTask(rig, wf.taskIds.On!);
    return rows.length >= 2;
  });
  expect(await runsForTask(rig, wf.taskIds.Off!)).toHaveLength(0);
});
