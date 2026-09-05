import type { BlobStore, EndpointPool, RunSession, TraceRecorder } from "@tabductor/browser";
import { openRunSession } from "@tabductor/browser";
import {
  activateScript,
  checkConsistency,
  compileTask,
  loadRunTraces,
  previousCleanAiRunIds,
  recordAiRun,
  recordCompiledRun,
  PROMOTE_AFTER_CLEAN_RUNS,
  type Llm as CompilerLlm,
  type PromotionOutcome,
  type RunTrace,
} from "@tabductor/compiler";
import { createLogger, newId, type Logger } from "@tabductor/core";
import type { Db, RunRow, TaskRow } from "@tabductor/db";
import type { PolicyGate } from "@tabductor/policy";
import type { CtxHost } from "@tabductor/static-rt";
import type { Metrics } from "@tabductor/telemetry";

/**
 * The compile loop, closed: what happens *after* a browser run, so that the next one is
 * cheaper.
 *
 * S6a–S6c built every piece — the cage, the shelf, the trace compiler, the promotion policy,
 * the executor with its deopt door — and left the wiring to "a caller". This is that caller.
 * It hangs off the two browser executors' `onOutcome` hooks and does three things:
 *
 * 1. **After an `ai` run** — load its trace (and its predecessor's, for the consistency
 *    check when there is one), compile, and let `recordAiRun` decide promotion. With K=1 the
 *    first clean run is enough: the script ships with guards and a deopt prompt, so an
 *    over-fitted script costs one slower run, not a wrong one.
 * 2. **After a `compiled` run** — feed the deopt window; on demotion, tell the bus
 *    (`compile.invalidated`) so the author sees it.
 * 3. **After a deopt the agent recovered** — the recovery trace is exactly what the next
 *    script should be compiled from (the site changed, the agent found the new path).
 *    Recompile from it and activate; the task never leaves `compiled`. This is the
 *    self-healing half of §11.
 *
 * Every step here is best-effort and logged: nothing in this file may fail the run it
 * follows, because the run already finished. A compile that fails leaves the task exactly as
 * it was, which is the state it would be in had this file not existed.
 */

export const COMPILE_INVALIDATED = "compile.invalidated";
export const COMPILE_PROMOTED = "compile.promoted";

export type CompileLoopDeps = {
  db: Db;
  pool: EndpointPool;
  gate: PolicyGate;
  blobs: BlobStore;
  /** Which endpoint the dry run drives — the same resolution the run itself used. */
  endpointFor: (task: TaskRow) => Promise<string>;
  /** The compiler's model. `trace` is where the compile's own LLM turns are recorded. */
  compileLlmFor: (opts: { task: TaskRow; trace: TraceRecorder }) => CompilerLlm;
  /** A system-event publisher for `compile.invalidated`/`compile.promoted`; omit to log only. */
  publish?: (input: { type: string; sourceTaskId: string; sourceRunId: string | null; packet: unknown }) => Promise<void>;
  metrics?: Metrics;
  logger?: Logger;
};

export type CompileLoop = {
  /** Wire into `AgentExecutorDeps.onOutcome`. Resolves to the promotion verdict for tests. */
  afterAiRun: (input: { task: TaskRow; run: RunRow; ok: boolean }) => Promise<PromotionOutcome | undefined>;
  /** Wire into `CompiledExecutorDeps.onOutcome`. */
  afterCompiledRun: (input: { task: TaskRow; run: RunRow; deopted: boolean; ok: boolean }) => Promise<void>;
};

/** The dry run leaves no trace rows: it is not a run, and its entries under a real run id
 * would read as that run having done things it did not do. */
const DISCARD_TRACE: TraceRecorder = {
  record: async () => {},
  flush: async () => {},
  close: async () => {},
};

/** A dry-run emit publishes nothing — the script is being *checked*, and an event it would
 * have emitted must not enter the bus on the strength of a check. */
const dryRunHostOf = (session: RunSession): CtxHost => ({
  session,
  emit: async (_type, _packet, _opts) => ({ ok: true, eventId: newId("dryrun") }),
  state: {
    get: async () => null,
    set: async () => {},
  },
});

export function createCompileLoop(deps: CompileLoopDeps): CompileLoop {
  const log = deps.logger ?? createLogger({ name: "compile-loop" });
  const { db, pool, gate, metrics } = deps;

  /**
   * One compile, all the way to a `candidate` row or a refusal. The dry run needs a page,
   * so it borrows an endpoint the same way a run does — the compiled script begins with its
   * own `page.goto`, so a blank tab is the right starting point.
   */
  const compileFrom = async (
    task: TaskRow,
    traces: RunTrace[],
    trace: TraceRecorder,
  ): Promise<{ ok: true; scriptId: string } | { ok: false; error: string }> => {
    const result = await compileTask(
      {
        db,
        llm: deps.compileLlmFor({ task, trace }),
        ...(metrics ? { metrics } : {}),
        dryRunHost: async () => {
          const lease = await pool.acquire(await deps.endpointFor(task), `compile:${newId("dryrun")}`);
          let session: RunSession;
          try {
            session = await openRunSession({
              conn: lease.conn,
              gate,
              taskCtx: { taskId: task.id, runId: `compile:${task.id}` },
              trace: DISCARD_TRACE,
            });
          } catch (err) {
            await lease.release().catch(() => undefined);
            throw err;
          }
          const inner = session;
          const wrapped: RunSession = {
            ...inner,
            close: async () => {
              await inner.close().catch(() => undefined);
              await lease.release().catch(() => undefined);
            },
          };
          return dryRunHostOf(wrapped);
        },
      },
      task.id,
      traces,
    );
    if (!result.ok) return { ok: false, error: `${result.stage}: ${result.error}` };
    return { ok: true, scriptId: result.script.id };
  };

  const afterAiRun: CompileLoop["afterAiRun"] = async ({ task, run, ok }) => {
    if (task.kind !== "browser" || task.mode !== "ai") return undefined;
    try {
      // The predecessor(s) this run must agree with. K=1 means promotion needs no
      // predecessor, but when one exists the two are still compared — a task whose runs keep
      // doing different things does not get compiled on the strength of whichever came last.
      const priorIds = ok
        ? await previousCleanAiRunIds(db, { taskId: task.id, excludeRunId: run.id, limit: Math.max(PROMOTE_AFTER_CLEAN_RUNS, 2) - 1 })
        : [];
      const traces = ok ? await loadRunTraces(db, [...priorIds, run.id]) : [];
      const outcome = await recordAiRun(
        {
          db,
          ...(metrics ? { metrics } : {}),
          compile: () => compileFrom(task, traces, DISCARD_TRACE),
        },
        task,
        { ok, consistent: ok && traces.length > 0 ? consistencyOf(traces) : ok },
      );
      if (outcome.promoted) {
        log.info("task promoted to compiled", { taskId: task.id, task: task.name, scriptId: outcome.scriptId, fromRuns: traces.map((t) => t.runId) });
        await deps.publish?.({
          type: COMPILE_PROMOTED,
          sourceTaskId: task.id,
          sourceRunId: run.id,
          packet: { taskId: task.id, scriptId: outcome.scriptId, fromRuns: traces.map((t) => t.runId) },
        });
      } else {
        log.info("task not promoted", { taskId: task.id, task: task.name, reason: outcome.reason });
      }
      return outcome;
    } catch (err) {
      log.warn("compile loop failed after ai run", { taskId: task.id, runId: run.id, error: String(err) });
      return undefined;
    }
  };

  const afterCompiledRun: CompileLoop["afterCompiledRun"] = async ({ task, run, deopted, ok }) => {
    if (task.kind !== "browser") return;
    try {
      const verdict = await recordCompiledRun({ db, ...(metrics ? { metrics } : {}) }, task, { deopted });
      if (verdict.demoted) {
        log.warn("task demoted to ai after repeated deopts", { taskId: task.id, task: task.name, deoptsInWindow: verdict.deoptsInWindow });
        await deps.publish?.({
          type: COMPILE_INVALIDATED,
          sourceTaskId: task.id,
          sourceRunId: run.id,
          packet: { taskId: task.id, deoptsInWindow: verdict.deoptsInWindow },
        });
        return;
      }
      if (deopted && ok) {
        // The recovery path is the new path. Recompile from this run alone: the runs the old
        // script was compiled from describe the layout that just stopped existing.
        const traces = await loadRunTraces(db, [run.id]);
        const compiled = await compileFrom(task, traces, DISCARD_TRACE);
        if (compiled.ok) {
          await activateScript(db, compiled.scriptId);
          log.info("recompiled after deopt recovery", { taskId: task.id, task: task.name, scriptId: compiled.scriptId, fromRun: run.id });
        } else {
          log.warn("recompile after deopt recovery failed; previous script stays active", { taskId: task.id, error: compiled.error });
        }
      }
    } catch (err) {
      log.warn("compile loop failed after compiled run", { taskId: task.id, runId: run.id, error: String(err) });
    }
  };

  return { afterAiRun, afterCompiledRun };
}

/** Pairwise agreement of the loaded traces — the same verdict `compileTask` re-derives, here
 * for the promotion counter (a diverging run resets the streak even when compile is skipped). */
function consistencyOf(traces: RunTrace[]): boolean {
  return traces.length < 2 || checkConsistency(traces).consistent;
}
