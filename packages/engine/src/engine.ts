import { publish, type Dispatcher } from "@tabductor/bus";
import { createLogger, type Logger } from "@tabductor/core";
import { runs, tasks, type Db, type EventRow, type RunRow, type TaskRow } from "@tabductor/db";
import { eq } from "drizzle-orm";
import { dispatchEvent } from "./dispatch.js";
import type { ExecutorRegistry, RunHandle, RunResult } from "./executor.js";
import { validatePacket } from "./packet-schema.js";
import { finishRun, reapTimedOutRuns, startRun } from "./run-state.js";
import { StubExecutor } from "./stub-executor.js";

export type EngineDeps = {
  db: Db;
  dispatcher: Dispatcher;
  /** Keyed by `tasks.mode`; defaults to `{ stub: StubExecutor }`. */
  executors?: ExecutorRegistry;
  /** Watchdog sweep interval. */
  watchdogIntervalMs?: number;
  /** How long `stop()` waits for in-flight runs before abandoning them. */
  shutdownGraceMs?: number;
  logger?: Logger;
};

export type Engine = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** One watchdog sweep, for tests that would otherwise wait on the interval. */
  sweepTimeouts: () => Promise<RunRow[]>;
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
  const log = deps.logger ?? createLogger({ name: "engine" });

  let unsubscribe: (() => void) | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  /** In-flight executions, so stop() can wait on runs rather than cutting them off mid-emit. */
  const inFlight = new Set<Promise<void>>();

  const track = (work: Promise<void>): void => {
    const tracked = work.finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
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
    const created = await dispatchEvent(db, event);
    for (const { runId } of created) {
      track(
        executeRun(runId, event).catch((err) => {
          log.error("run execution crashed", { runId, error: String(err) });
        }),
      );
    }
  };

  const executeRun = async (runId: string, trigger: EventRow): Promise<void> => {
    const [row] = await db
      .select({ run: runs, task: tasks })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, runId));
    if (!row) return;

    const { task } = row;
    const executor = executors[task.mode];
    if (!executor) {
      await startRun(db, runId, undefined);
      await finishRun(db, {
        runId,
        taskId: task.id,
        status: "failed",
        error: `no executor registered for mode "${task.mode}"`,
        causationId: trigger.eventId,
      });
      return;
    }

    const started = await startRun(db, runId, runTimeoutMs(task));
    if (!started) return; // someone else already took it out of `queued`

    const result = await runExecutor(executor, { run: started, task, trigger });
    await finishRun(db, {
      runId,
      taskId: task.id,
      status: result.ok ? "succeeded" : "failed",
      error: result.ok ? undefined : result.error,
      causationId: trigger.eventId,
    });
  };

  const runExecutor = async (
    executor: ExecutorRegistry[string],
    ctx: { run: RunRow; task: TaskRow; trigger: EventRow },
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
      if (unsubscribe) return;
      unsubscribe = dispatcher.subscribe(onEvent);
      watchdog = setInterval(() => void sweepTimeouts(), watchdogIntervalMs);
      watchdog.unref?.();
    },

    /**
     * Stops taking work and gives in-flight runs a bounded chance to finish. Bounded on
     * purpose: an executor that is genuinely stuck (a wedged browser, a hanging stub) must
     * not be able to hold shutdown open forever. Runs abandoned here are left `running`
     * and belong to the watchdog — which is exactly the crash-recovery path S2b builds on.
     */
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (watchdog) clearInterval(watchdog);
      watchdog = undefined;
      if (inFlight.size === 0) return;

      const abandoned = await Promise.race([
        Promise.allSettled([...inFlight]).then(() => false),
        new Promise<true>((r) => setTimeout(() => r(true), shutdownGraceMs).unref?.()),
      ]);
      if (abandoned) log.warn("stopped with runs still in flight", { count: inFlight.size });
    },

    sweepTimeouts,
  };
}

/**
 * Validate-then-publish, in that order, and the publish is transactional so an event never
 * exists without its outbox row. Validation failure throws: the executor sees it, and the
 * run fails with the schema error as its message.
 */
async function emitFromRun(
  db: Db,
  ctx: { run: RunRow; task: TaskRow; trigger: EventRow },
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
      causationId: ctx.trigger.eventId,
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
