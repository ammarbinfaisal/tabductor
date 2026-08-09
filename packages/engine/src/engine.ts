import { publish, type Dispatcher } from "@tabductor/bus";
import { createLogger, type Logger } from "@tabductor/core";
import { events, runs, tasks, type Db, type EventRow, type RunRow, type TaskRow } from "@tabductor/db";
import { eq } from "drizzle-orm";
import { dispatchEvent } from "./dispatch.js";
import type { ExecutorRegistry, RunHandle, RunResult } from "./executor.js";
import { validatePacket } from "./packet-schema.js";
import { scheduleRetry } from "./retry.js";
import {
  dueQueuedRuns,
  finishRun,
  heartbeat,
  reapTimedOutRuns,
  recoverStaleRuns,
  startRun,
} from "./run-state.js";
import { createScheduler, type Scheduler } from "./scheduler.js";
import { StubExecutor } from "./stub-executor.js";

export type EngineDeps = {
  db: Db;
  dispatcher: Dispatcher;
  /** Keyed by `tasks.mode`; defaults to `{ stub: StubExecutor }`. */
  executors?: ExecutorRegistry;
  /** Watchdog sweep interval; also how often queued runs due to start are picked up. */
  watchdogIntervalMs?: number;
  /** How long `stop()` waits for in-flight runs before abandoning them. */
  shutdownGraceMs?: number;
  /** How often a `running` run pings `runs.heartbeat_at`. */
  heartbeatIntervalMs?: number;
  /**
   * How quiet a `running` run's heartbeat must be, on boot, to count as crashed. Must
   * comfortably exceed `heartbeatIntervalMs` or a live run gets recovered out from under
   * itself.
   */
  staleHeartbeatMs?: number;
  /** Cron scheduler; omitted means no scheduler at all. `now` fakes its clock. */
  scheduler?: { tickMs?: number; now?: () => number } | false;
  logger?: Logger;
};

export type Engine = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** One watchdog sweep, for tests that would otherwise wait on the interval. */
  sweepTimeouts: () => Promise<RunRow[]>;
  /** `undefined` when no scheduler was configured. */
  scheduler?: Scheduler;
};

/**
 * Composition root for the run loop: subscribe to the bus, turn each event into runs,
 * execute them, and reap runs that overstayed their deadline. Everything it wires is a
 * plain function or a plain object, so S2b adds the scheduler, retries, and crash recovery
 * by wiring more of the same rather than by reworking this.
 */
export function createEngine(deps: EngineDeps): Engine {
  const { db, dispatcher } = deps;
  const executors: ExecutorRegistry = deps.executors ?? { stub: StubExecutor };
  const watchdogIntervalMs = deps.watchdogIntervalMs ?? 250;
  const shutdownGraceMs = deps.shutdownGraceMs ?? 5_000;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 2_000;
  const staleHeartbeatMs = deps.staleHeartbeatMs ?? 30_000;
  const log = deps.logger ?? createLogger({ name: "engine" });
  const scheduler =
    deps.scheduler === false
      ? undefined
      : createScheduler({ db, logger: log, ...(deps.scheduler ?? {}) });

  let unsubscribe: (() => void) | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let running = false;
  /** In-flight executions, so stop() can wait on runs rather than cutting them off mid-emit. */
  const inFlight = new Set<Promise<void>>();
  /** Run ids this process already handed to an executor, so the pickup poll skips them. */
  const claimed = new Set<string>();

  const track = (work: Promise<void>): void => {
    const tracked = work.finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
  };

  /** One execution, tracked and never allowed to reject into a timer callback. */
  const launch = (runId: string, trigger: EventRow | null): void => {
    if (claimed.has(runId)) return;
    claimed.add(runId);
    track(
      executeRun(runId, trigger)
        .catch((err) => log.error("run execution crashed", { runId, error: String(err) }))
        .finally(() => claimed.delete(runId)),
    );
  };

  /**
   * The bus subscriber. It runs *inside* the dispatcher's claiming transaction, which holds
   * a row lock for as long as it takes — so it does the short, transactional part (create
   * the pinned runs) and hands execution off to the background rather than awaiting it. A
   * ten-minute browser run must not keep an outbox row locked for ten minutes.
   *
   * Throwing here would retry the whole event, so it never does: a run's failure belongs on
   * the run row, not on the event's delivery count.
   */
  const onEvent = async (event: EventRow): Promise<void> => {
    for (const { runId } of await dispatchEvent(db, event)) launch(runId, event);
  };

  /**
   * The other way a run starts: it was already in the table. Retries queued with a backoff
   * and runs left behind by a dead process have no event delivery coming for them, so the
   * queue is polled. `startRun` is the compare-and-set that settles any race this creates
   * with the delivery path or with another engine.
   */
  const pickUpQueuedRuns = async (): Promise<void> => {
    for (const run of await dueQueuedRuns(db)) launch(run.id, null);
  };

  const executeRun = async (runId: string, delivered: EventRow | null): Promise<void> => {
    const [row] = await db
      .select({ run: runs, task: tasks })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, runId));
    if (!row) return;

    const { task } = row;
    // A retry or a polled pickup arrives without the event in hand; the run row remembers it.
    const trigger = delivered ?? (await triggerEvent(db, row.run));
    const causationId = trigger?.eventId ?? null;

    const executor = executors[task.mode];
    if (!executor) {
      // Permanent: retrying a task whose mode has no executor registered just burns the
      // policy on the same missing registration.
      const started = await startRun(db, runId, undefined);
      if (!started) return;
      const error = `no executor registered for mode "${task.mode}"`;
      await settle(started, task, { ok: false, error, permanent: true }, causationId);
      return;
    }

    const started = await startRun(db, runId, runTimeoutMs(task));
    if (!started) return; // already taken, or still inside its retry backoff

    const ping = setInterval(() => void heartbeat(db, runId).catch(() => {}), heartbeatIntervalMs);
    ping.unref?.();
    let result: RunResult;
    try {
      result = await runExecutor(executor, { run: started, task, trigger });
    } finally {
      clearInterval(ping);
    }
    await settle(started, task, result, causationId);
  };

  /**
   * Terminal transition plus, on a retryable failure, the next attempt. The retry is queued
   * only when this call is the one that moved the run to `failed` — if the watchdog got
   * there first the run is `timed_out` and belongs to whoever reaped it.
   */
  const settle = async (
    run: RunRow,
    task: TaskRow,
    result: RunResult,
    causationId: string | null,
  ): Promise<void> => {
    const finished = await finishRun(db, {
      runId: run.id,
      taskId: task.id,
      status: result.ok ? "succeeded" : "failed",
      error: result.ok ? undefined : result.error,
      causationId,
    });
    if (!finished || result.ok || result.permanent) return;
    await scheduleRetry(db, { run: finished, task, error: result.error });
  };

  const runExecutor = async (
    executor: ExecutorRegistry[string],
    ctx: { run: RunRow; task: TaskRow; trigger: EventRow | null },
  ): Promise<RunResult> => {
    const handle: RunHandle = {
      run: ctx.run,
      task: ctx.task,
      trigger: ctx.trigger,
      emit: (type, packet) => emitFromRun(db, ctx, type, packet),
    };
    try {
      return await executor.execute(handle);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const sweepTimeouts = async (): Promise<RunRow[]> => {
    try {
      return await reapTimedOutRuns(db);
    } catch (err) {
      log.error("watchdog sweep failed", { error: String(err) });
      return [];
    }
  };

  return {
    async start() {
      if (running) return;
      running = true;

      // Crash recovery first (§15): a run this process is about to pick up must not be
      // mistaken for one the *previous* process abandoned. Each recovered run goes through
      // the retry policy exactly like any other failure — re-run from the start, never
      // resume, so a half-finished browser run is simply retried.
      for (const run of await recoverStaleRuns(db, staleHeartbeatMs)) {
        const [task] = await db.select().from(tasks).where(eq(tasks.id, run.taskId));
        if (task) await scheduleRetry(db, { run, task, error: run.error });
      }

      unsubscribe = dispatcher.subscribe(onEvent);
      watchdog = setInterval(() => {
        void sweepTimeouts();
        void pickUpQueuedRuns().catch((err) => log.error("queued pickup failed", { error: String(err) }));
      }, watchdogIntervalMs);
      watchdog.unref?.();
      await scheduler?.start();
    },

    /**
     * Stops taking work and gives in-flight runs a bounded chance to finish. Bounded on
     * purpose: an executor that is genuinely stuck (a wedged browser, a hanging stub) must
     * not be able to hold shutdown open forever. Runs abandoned here are left `running`
     * and belong to the watchdog — which is exactly the crash-recovery path S2b builds on.
     */
    async stop() {
      running = false;
      unsubscribe?.();
      unsubscribe = undefined;
      if (watchdog) clearInterval(watchdog);
      watchdog = undefined;
      await scheduler?.stop();
      if (inFlight.size === 0) return;

      const abandoned = await Promise.race([
        Promise.allSettled([...inFlight]).then(() => false),
        new Promise<true>((r) => setTimeout(() => r(true), shutdownGraceMs).unref?.()),
      ]);
      if (abandoned) log.warn("stopped with runs still in flight", { count: inFlight.size });
    },

    sweepTimeouts,
    scheduler,
  };
}

/** The event that triggered a run, when it still has one — a schedule fire always does. */
async function triggerEvent(db: Db, run: RunRow): Promise<EventRow | null> {
  if (!run.triggerEventId) return null;
  const [row] = await db.select().from(events).where(eq(events.eventId, run.triggerEventId));
  return row ?? null;
}

/**
 * Validate-then-publish, in that order, and the publish is transactional so an event never
 * exists without its outbox row. Validation failure throws: the executor sees it, and the
 * run fails with the schema error as its message.
 */
async function emitFromRun(
  db: Db,
  ctx: { run: RunRow; task: TaskRow; trigger: EventRow | null },
  type: string,
  packet: unknown,
): Promise<EventRow> {
  const check = await validatePacket(db, ctx.task.id, type, packet);
  if (!check.ok) throw new Error(check.error);

  return db.transaction((trx) =>
    publish(trx, {
      type,
      sourceTaskId: ctx.task.id,
      sourceRunId: ctx.run.id,
      causationId: ctx.trigger?.eventId ?? null,
      packet,
    }),
  );
}

/** Run timeout lives in `limits_json.run_timeout_ms`; anything non-numeric means no limit. */
function runTimeoutMs(task: TaskRow): number | undefined {
  const limits = task.limitsJson;
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) return undefined;
  const value = Reflect.get(limits, "run_timeout_ms");
  return typeof value === "number" && value > 0 ? value : undefined;
}
