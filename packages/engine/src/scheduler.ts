import { publish } from "@tabductor/bus";
import { createLogger, type Logger } from "@tabductor/core";
import { runs, schedules, type Db, type ScheduleRow } from "@tabductor/db";
import { Cron } from "croner";
import { and, eq, inArray, sql } from "drizzle-orm";
import { dispatchToTask } from "./dispatch.js";

/**
 * Cron scheduler (§7). Schedules are just another event source: a due fire publishes a
 * synthetic `schedule.fired` event with an empty packet and no causation, and the run it
 * creates goes through the ordinary dispatch path.
 *
 * The `schedules` row is the source of truth, not this loop. Nothing here is remembered
 * across a tick — every tick re-reads the table and recomputes from `last_fired_at`, so a
 * restart loses nothing and two engines can run the same schedules without diverging (the
 * `last_fired_at` compare-and-set below is what keeps them from double-firing).
 */

export const SCHEDULE_FIRED = "schedule.fired";
export const SCHEDULE_SKIPPED = "system.schedule_skipped";

/** Statuses that mean "this task is already working" for the overlap policy. */
const LIVE = ["queued", "running"] as const;

export type SchedulerDeps = {
  db: Db;
  /** How often the DB is re-read for due schedules. */
  tickMs?: number;
  /**
   * Injectable clock (ms since epoch), so tests can place "now" wherever the case needs it
   * rather than waiting for wall time. One parameter, not a Clock interface.
   */
  now?: () => number;
  logger?: Logger;
};

export type Scheduler = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** One pass over all schedules, for tests that would otherwise wait on the interval. */
  tick: () => Promise<number>;
};

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { db } = deps;
  const tickMs = deps.tickMs ?? 250;
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? createLogger({ name: "scheduler" });

  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  /** Schedules already put through the missed-fire policy this process. */
  const booted = new Set<string>();

  /**
   * One pass. Ticks never overlap — a slow pass (a fire that has to touch the outbox for
   * every schedule) must not have the next interval pile up behind it.
   */
  const tick = async (): Promise<number> => {
    if (ticking) return 0;
    ticking = true;
    try {
      const rows = await db.select().from(schedules).where(eq(schedules.enabled, true));
      let fired = 0;
      for (const row of rows) {
        try {
          if (await visit(row)) fired += 1;
        } catch (err) {
          log.error("schedule tick failed", { scheduleId: row.id, error: String(err) });
        }
      }
      return fired;
    } finally {
      ticking = false;
    }
  };

  /**
   * The whole per-schedule decision: is it due, and if so does the overlap policy let it
   * through? First sight of a schedule in this process goes through the missed-fire policy
   * instead, which is the only thing that ever looks at downtime.
   */
  const visit = async (row: ScheduleRow): Promise<boolean> => {
    const at = now();
    const cron = cronFor(row);
    if (!cron) {
      log.warn("schedule has an invalid cron expression", { scheduleId: row.id, cron: row.cron });
      return false;
    }

    if (!booted.has(row.id)) {
      booted.add(row.id);
      if (missedACatchUpTick(cron, row, at)) return fire(row, at);
      // Otherwise start the schedule from *here*: a never-fired schedule has no history to
      // count from, and a `skip` policy has just decided to forget the one it had. Both
      // want the same thing — `last_fired_at` pinned to now, so the next occurrence is
      // computed from a fixed point in the past instead of from a "now" that slides
      // forward with every tick and is therefore never reached.
      await db.update(schedules).set({ lastFiredAt: new Date(at) }).where(eq(schedules.id, row.id));
      return false;
    }

    const due = row.lastFiredAt && cron.nextRun(row.lastFiredAt);
    if (!due || due.getTime() > at) return false;
    return fire(row, at);
  };

  /**
   * Claim the tick, then decide whether to run it.
   *
   * The claim is first and it is a compare-and-set on `last_fired_at`: only the writer that
   * moved the row forward from the value it read owns this tick, so a second engine (or a
   * tick that overlapped a slow one) finds it already taken. A skipped fire still consumes
   * its tick — the point of `skip` is that the tick is dropped, not deferred.
   */
  const fire = async (row: ScheduleRow, at: number): Promise<boolean> => {
    const claimed = await db
      .update(schedules)
      .set({ lastFiredAt: new Date(at) })
      .where(
        and(
          eq(schedules.id, row.id),
          row.lastFiredAt === null
            ? sql`${schedules.lastFiredAt} is null`
            : eq(schedules.lastFiredAt, row.lastFiredAt),
        ),
      )
      .returning({ id: schedules.id });
    if (claimed.length === 0) return false;

    const live = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.taskId, row.taskId), inArray(runs.status, [...LIVE])));

    // `skip` tolerates nothing live; `queue` tolerates the live one plus at most one behind it.
    const allowed = row.overlapPolicy === "queue" ? 2 : 1;
    if (live.length >= allowed) {
      await db.transaction((trx) =>
        publish(trx, {
          type: SCHEDULE_SKIPPED,
          sourceTaskId: row.taskId,
          packet: {
            scheduleId: row.id,
            taskId: row.taskId,
            policy: row.overlapPolicy,
            liveRuns: live.length,
          },
        }),
      );
      return false;
    }

    // Synthetic trigger: empty packet, no causation — a schedule fire starts a chain, it
    // never continues one, which is also what keeps it off the loop budget.
    const event = await db.transaction((trx) =>
      publish(trx, { type: SCHEDULE_FIRED, sourceTaskId: row.taskId, packet: {} }),
    );

    // The event carries no edge, so it is dispatched *at* the task — same run creation,
    // same claim, same loop budget as any other trigger.
    await dispatchToTask(db, row.taskId, event);
    return true;
  };

  return {
    async start() {
      if (timer) return;
      await tick(); // boot pass: missed-fire policy applies before the first interval
      timer = setInterval(() => void tick().catch(() => {}), tickMs);
      timer.unref?.();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      booted.clear();
    },

    tick,
  };
}

/**
 * Missed-fire policy (§7), evaluated once per schedule per process against `last_fired_at`.
 *
 * "Missed" means a tick came due while nobody was running: the next occurrence after the
 * last fire is already in the past. Only `fire_once_catchup` acts on that, and it fires
 * exactly one event however many ticks went by — never replay a backlog against a live
 * website. `skip` (and a schedule that has never fired) has nothing to do here; the caller
 * rebases it on now instead.
 */
function missedACatchUpTick(cron: Cron, row: ScheduleRow, at: number): boolean {
  if (row.missedPolicy !== "fire_once_catchup" || !row.lastFiredAt) return false;
  const due = cron.nextRun(row.lastFiredAt);
  return due !== null && due.getTime() <= at;
}

/** `undefined` for an unparseable expression — a bad schedule is skipped, never fatal. */
function cronFor(row: ScheduleRow): Cron | undefined {
  try {
    return new Cron(row.cron, { timezone: row.tz });
  } catch {
    return undefined;
  }
}
