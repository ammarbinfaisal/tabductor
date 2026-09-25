import {
  claimCompileJob,
  compileTask,
  finishCompileJob,
  heartbeatCompileJob,
  loadRunTraces,
  previousCleanAiRunIds,
  promoteTask,
  recordCompiledRun,
  taskForJob,
  type CompileResult,
  type Llm as CompilerLlm,
} from "@tabductor/compiler";
import { browserLearningDefinition, createLogger, type Logger } from "@tabductor/core";
import { browserLearningJobs, type CompileJobRow, type Db, type RunRow, type TaskRow } from "@tabductor/db";
import { eq } from "drizzle-orm";
import { enqueueBrowserLearning } from "./learning-loop.js";
import type { Metrics } from "@tabductor/telemetry";

/**
 * The compile loop, in two halves that no longer touch each other.
 *
 * **The hooks** (`afterAiRun`, `afterCompiledRun`) run inside the executor's `finally`, and do
 * only cheap bookkeeping: feed the deopt window, demote a task that keeps deopting, and
 * enqueue post-run learning. No model call, page or validation delays run settlement.
 * The independent learning worker updates operating/deopt prompts and queues compilation
 * only when it judges a successful run ready for the static path.
 *
 * **The worker** (`createCompileWorker`) claims those rows afterwards. `claimCompileJob` will
 * not hand out a job whose source run is still in flight, so by the time a compile begins the
 * run is terminal, its trace is flushed and its endpoint lease is released — the lifecycle
 * `trace-compilation.md` requires, enforced by the query rather than by timing.
 *
 * This is the S6e correction to S6d's wiring, which awaited the whole compile — LLM pass,
 * browser dry run and all — inside the executor's own lifetime. A slow compiler delayed the
 * run's terminal transition; a wedged one could eat the run's timeout; and a compile failure
 * ran in the same `finally` as the run's cleanup. Compilation now has its own outcome, its own
 * timeout and its own retry budget, and nothing it does can change a run that already finished.
 */

export const COMPILE_INVALIDATED = "compile.invalidated";
export const COMPILE_PROMOTED = "compile.promoted";

/** How long one compile may take before the worker abandons it. Generous: two model turns plus
 * three isolate runs. Bounded: a compile that hangs must not hold the job's claim forever. */
export const COMPILE_TIMEOUT_MS = 180_000;

export type CompileHooksDeps = {
  db: Db;
  /** Publishes `compile.invalidated` when the deopt budget demotes a task. Demotion is the
   * one thing here that a user has to be told about, and it costs one insert — so it stays on
   * the hook rather than waiting for a worker tick. */
  publish?: (input: { type: string; sourceTaskId: string; sourceRunId: string | null; packet: unknown }) => Promise<void>;
  logger?: Logger;
  metrics?: Metrics;
};

export type CompileLoop = {
  /** Wire into `AgentExecutorDeps.onOutcome`. Resolves once the queue row is written. */
  afterAiRun: (input: { task: TaskRow; run: RunRow; ok: boolean }) => Promise<{ enqueued: boolean; reason: string }>;
  /** Wire into `CompiledExecutorDeps.onOutcome`. */
  afterCompiledRun: (input: { task: TaskRow; run: RunRow; deopted: boolean; plannedDeopted?: boolean; ok: boolean;
    scriptId?: string; scriptKey?: string; deoptKey?: string }) => Promise<void>;
};

/**
 * The executor-side half. Everything here is best-effort and logged: nothing may fail the run
 * it follows, because the run already finished.
 */
export function createCompileLoop(deps: CompileHooksDeps): CompileLoop {
  const log = deps.logger ?? createLogger({ name: "compile-loop" });
  const { db } = deps;

  const afterAiRun: CompileLoop["afterAiRun"] = async ({ task, run }) => {
    if (task.kind !== "browser" || task.mode !== "ai") return { enqueued: false, reason: "not a browser ai task" };
    try {
      const job = await enqueueBrowserLearning(db, { task, run });
      return { enqueued: !!job, reason: job ? "queued post-run learning" : "run already queued for learning" };
    } catch (err) {
      log.warn("could not queue learning after an ai run", { taskId: task.id, runId: run.id, error: String(err) });
      return { enqueued: false, reason: String(err) };
    }
  };

  const afterCompiledRun: CompileLoop["afterCompiledRun"] = async ({ task, run, deopted, plannedDeopted = false, ok, scriptId, scriptKey, deoptKey }) => {
    if (task.kind !== "browser") return;
    try {
      if (deopted || !ok) await enqueueBrowserLearning(db, { task, run,
        context: { scriptId, scriptKey, deoptKey: scriptId ? deoptKey ?? "recovery" : undefined, planned: plannedDeopted } });
      // Planned handoffs are part of a hybrid artifact, not evidence that its guards went stale.
      const invalidatingDeopt = deopted && !plannedDeopted;
      const verdict = await recordCompiledRun({ db, ...(deps.metrics ? { metrics: deps.metrics } : {}) }, task, { deopted: invalidatingDeopt, scriptId });
      if (verdict.demoted) {
        log.warn("task demoted to ai after repeated deopts", {
          taskId: task.id,
          task: task.name,
          deoptsInWindow: verdict.deoptsInWindow,
        });
        await deps.publish?.({
          type: COMPILE_INVALIDATED,
          sourceTaskId: task.id,
          sourceRunId: run.id,
          packet: { taskId: task.id, deoptsInWindow: verdict.deoptsInWindow },
        });
        return;
      }
    } catch (err) {
      log.warn("compile loop failed after compiled run", { taskId: task.id, runId: run.id, error: String(err) });
    }
  };

  return { afterAiRun, afterCompiledRun };
}

export type CompileWorkerDeps = {
  validatePython?: import("@tabductor/compiler").CompileDeps["validatePython"];
  db: Db;
  blobs?: { get(ref: string): Promise<Buffer> };
  /** The compiler's model, per job. Kept a factory for the same reason executors keep one:
   * a transcript-replaying test rig picks a fixture per task. */
  compileLlmFor: (opts: { task: TaskRow; job: CompileJobRow }) => CompilerLlm;
  /** A system-event publisher for `compile.promoted`/`compile.invalidated`; omit to log only. */
  publish?: (input: { type: string; sourceTaskId: string; sourceRunId: string | null; packet: unknown }) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
  metrics?: Metrics;
  logger?: Logger;
};

export type CompileWorker = {
  start: () => void;
  stop: () => Promise<void>;
  /** One claim-and-compile, for tests and for a caller that wants to drain the queue by hand.
   * Resolves `null` when nothing was due. */
  runOnce: () => Promise<{ job: CompileJobRow; result: CompileResult } | null>;
};

/** Whatever a compile threw, as a retryable failure — a transport error is not a refusal, and
 * the job's own attempt budget is what stops it repeating forever. */
function asFailure(err: unknown): { status: "failed"; error: string } {
  return { status: "failed", error: err instanceof Error ? err.message : String(err) };
}

export function createCompileWorker(deps: CompileWorkerDeps): CompileWorker {
  const log = deps.logger ?? createLogger({ name: "compile-worker" });
  const { db } = deps;
  const pollMs = deps.pollMs ?? 1_000;
  const timeoutMs = deps.timeoutMs ?? COMPILE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();
  let stopped = false;

  /** Compilation's own wall clock. The run it followed has long since settled, so this bounds
   * nothing but the compile — which is the entire point of it being separate. */
  const withTimeout = async <T>(work: Promise<T>, label: string): Promise<T> =>
    await Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs).unref?.(),
      ),
    ]);

  const runOnce: CompileWorker["runOnce"] = async () => {
    const job = await claimCompileJob(db);
    if (!job) return null;

    const beat = setInterval(() => void heartbeatCompileJob(db, job.id, job.attempts).catch(() => undefined), 30_000);
    beat.unref?.();
    try {
      const task = await taskForJob(db, job);
      if (!task) {
        await finishCompileJob(db, job, { status: "refused", error: "the task no longer exists" });
        return null;
      }
      if (task.contentHash !== job.contentHash) {
        // graph-compilation-llm §6.3: an artifact must match the task content it implements.
        // The node was edited or republished while this job waited; its evidence describes
        // work that is no longer the task's definition.
        await finishCompileJob(db, job, { status: "refused", error: "the task changed after this run" });
        log.info("compile abandoned: task content changed", { taskId: task.id, jobId: job.id });
        return null;
      }
      const [learning] = job.learningJobId ? await db.select().from(browserLearningJobs).where(eq(browserLearningJobs.id, job.learningJobId)) : [];
      if (!learning || learning.status !== "succeeded" || !learning.compileRequested || learning.runId !== job.runId ||
          learning.taskId !== task.id || browserLearningDefinition(task) !== learning.definitionHash) {
        await finishCompileJob(db, job, { status: "refused", error: "Compilation requires a current learner-approved successful run" });
        return null;
      }

      // Supporting evidence: earlier clean `ai` runs of the same task. They widen what the
      // plan may be grounded in and are compared *as distilled work*, never as step sequences.
      //
      // Not for a recompile, though: that job exists because a script's guards stopped holding,
      // and the older runs describe the layout that just stopped existing. The recovery trace
      // is the only evidence of the page as it is now.
      const priorIds =
        job.reason === "promote"
          ? await previousCleanAiRunIds(db, { taskId: task.id, excludeRunId: job.runId, limit: 2 })
          : [];
      const traces = await loadRunTraces(db, [job.runId, ...priorIds], deps.blobs);

      const result = await withTimeout(
        compileTask(
          {
            db,
            validatePython: deps.validatePython,
            llm: deps.compileLlmFor({ task, job }),
            ...(deps.metrics ? { metrics: deps.metrics } : {}),
          },
          { taskId: task.id, sourceRunId: job.runId, traces, learning: learning.resultJson ?? undefined },
        ),
        `compile of task ${task.id}`,
      );

      if (!result.ok) {
        await finishCompileJob(db, job, { status: "refused", error: `${result.stage}: ${result.error}` });
        log.info("compile refused", { taskId: task.id, jobId: job.id, stage: result.stage, error: result.error });
        return { job, result };
      }

      const promotion = await promoteTask(
        { db, ...(deps.metrics ? { metrics: deps.metrics } : {}) },
        { taskId: task.id, scriptId: result.script.id, expectContentHash: job.contentHash,
          expectScriptId: job.expectedScriptId, expectDefinitionHash: learning.definitionHash, compileJob: { id: job.id, attempts: job.attempts } },
      );
      if (!promotion.promoted) {
        await finishCompileJob(db, job, { status: "refused", error: promotion.reason });
        log.info("candidate compiled but not promoted", { taskId: task.id, reason: promotion.reason });
        return { job, result };
      }
      await finishCompileJob(db, job, { status: "succeeded", scriptId: result.script.id });
      log.info("task promoted to compiled", {
        taskId: task.id,
        task: task.name,
        scriptId: result.script.id,
        fromRuns: result.script.fromRuns,
      });
      await deps.publish?.({
        type: COMPILE_PROMOTED,
        sourceTaskId: task.id,
        sourceRunId: job.runId,
        packet: { taskId: task.id, scriptId: result.script.id, fromRuns: result.script.fromRuns, reason: job.reason },
      });
      return { job, result };
    } catch (err) {
      await finishCompileJob(db, job, asFailure(err)).catch(() => undefined);
      log.warn("compile job failed", { jobId: job.id, taskId: job.taskId, error: String(err) });
      return null;
    } finally {
      clearInterval(beat);
    }
  };

  // One compile at a time per worker. Compilation is not urgent — the run it follows is
  // already finished — and a tick that fired while the last one was still in an isolate would
  // just add a second model call to the same process for no earlier answer.
  let busy = false;
  const tick = (): void => {
    if (stopped || busy) return;
    busy = true;
    inFlight = runOnce()
      .catch((err) => log.warn("compile worker tick failed", { error: String(err) }))
      .finally(() => {
        busy = false;
      });
  };

  return {
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(tick, pollMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight.catch(() => undefined);
    },
    runOnce,
  };
}
