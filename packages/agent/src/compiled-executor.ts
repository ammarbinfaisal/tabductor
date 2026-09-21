import { withAutomationControl } from "@tabductor/browser";
import { AppError, SCRIPT_RUNTIME_VERSION } from "@tabductor/core";
import {
  createTraceRecorder,
  openRunSession,
  type BlobStore,
  type EndpointLease,
  type EndpointPool,
  type ResourceLimits,
  type RunSession,
  type StorageFlags,
  type TraceRecorder,
} from "@tabductor/browser";
import { getActiveScript, invalidateScript } from "@tabductor/compiler";
import { taskState, tasks, type Db, type RunRow, type TaskRow } from "@tabductor/db";
import { assertRunLease, type RunHandle, type RunResult, type TaskExecutor } from "@tabductor/engine";
import type { PolicyGate } from "@tabductor/core";
import { runCompiledScript, type CtxHost, type StateStore } from "@tabductor/static-rt";
import type { Metrics } from "@tabductor/telemetry";
import { and, eq } from "drizzle-orm";
import type { Llm } from "./llm.js";
import { runAgentLoop } from "./loop.js";
import {
  asNumber,
  asRecord,
  makeEmitFn,
  maxInputTokensOf,
  storageFlagsOf as defaultStorageFlagsOf,
  toRunResult,
  triggerInfoOf,
} from "./executor-shared.js";
import { buildToolRegistry, summarizePerception } from "./tools.js";
import { browserLoopControl } from "./browser-loop-control.js";

/**
 * `(browser, compiled)` — the fast path, and the door back to the slow one.
 *
 * A clean compiled run makes **no model call at all**: the script drives the page through the
 * same `ctx` S6a built, every crossing lands on the same `PolicyGate` an agent run would hit,
 * and the trace it leaves has zero `llm` entries. That absence is the product's core claim,
 * and the flagship test asserts it rather than trusting it.
 *
 * When the guards fail, `ctx.deopt` does **not** fail the run. The same run row continues under
 * the agent loop, on the same session, with the page exactly where the script left it — the
 * compiler-authored recovery prompt, the original task prompt and the guard evidence are what
 * the agent wakes up to. `runs.mode_used` stays `compiled`, because the run *was* a compiled
 * run; what changed is that it needed help finishing.
 *
 * **Why this lives in `packages/agent` rather than beside the registry it reads** (a stated
 * deviation from S6c's placement note): the handoff target is `runAgentLoop`, and
 * `packages/agent` already imports `packages/engine`. Putting the executor in `engine` would
 * require `engine → agent`, closing a cycle. Everything else it needs — the registry, the
 * sandbox — imports neither, so this direction is the only one that exists.
 */

export type CompiledExecutorDeps = {
  pool: EndpointPool;
  gate: PolicyGate;
  blobs: BlobStore;
  db: Db;
  /** See `AgentExecutorDeps.endpointFor`. */
  endpointFor: (handle: RunHandle) => Promise<string>;
  /** Only ever built when a deopt actually happens — a clean compiled run never calls this,
   * which is what makes "zero LLM calls" true of the wiring and not just of the transcript. */
  llmFor: (opts: { trace: TraceRecorder; task: TaskRow; runId: string }) => Llm;
  metrics?: Metrics;
  storageFlagsOf?: (task: TaskRow) => StorageFlags;
  /**
   * Called after the run settles, with whether it deopted. S6c's demotion policy lives here;
   * injected so the executor stays a code path and not a coordinator.
   */
  onOutcome?: (input: { task: TaskRow; run: RunRow; deopted: boolean; ok: boolean }) => Promise<void>;
};

/** `limits_json.static_rt.{max_wall_ms,max_memory_mb}` — may only tighten S6a's defaults. */
function staticRtLimitsOf(task: TaskRow): { wallClockMs?: number; memoryMb?: number } {
  const cfg = asRecord(asRecord(task.limitsJson)?.static_rt);
  if (!cfg) return {};
  const wall = asNumber(cfg.max_wall_ms);
  const mem = asNumber(cfg.max_memory_mb);
  return {
    ...(wall !== undefined && wall > 0 ? { wallClockMs: wall } : {}),
    ...(mem !== undefined && mem > 0 ? { memoryMb: mem } : {}),
  };
}

function browserLimitsOf(task: TaskRow): ResourceLimits | undefined {
  const browser = asRecord(asRecord(task.limitsJson)?.browser);
  if (!browser) return undefined;
  const limits: ResourceLimits = {};
  const wall = asNumber(browser.max_wall_ms);
  const tabs = asNumber(browser.max_tabs);
  if (wall !== undefined) limits.maxWallMs = wall;
  if (tabs !== undefined) limits.maxTabs = tabs;
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/** `ctx.state`, on the same `task_state` table `emitIfNew`'s dedupe claim already rides. */
function taskStateStore(db: Db, handle: RunHandle): StateStore {
  const taskId = handle.task.id;
  return {
    async get(key) {
      const [row] = await db
        .select({ value: taskState.value })
        .from(taskState)
        .where(and(eq(taskState.taskId, taskId), eq(taskState.key, `state:${key}`)));
      return row?.value ?? null;
    },
    async set(key, value) {
      await db.transaction(async (trx) => {
        await assertRunLease(trx, handle.run.id, handle.run.leaseGeneration);
        await trx
        .insert(taskState)
        .values({ taskId, key: `state:${key}`, value: value as Record<string, unknown> })
        .onConflictDoUpdate({
          target: [taskState.taskId, taskState.key],
          set: { value: value as Record<string, unknown> },
        });
      });
    },
  };
}

/** What the agent wakes up to. The compiler wrote the first paragraph for exactly this moment. */
function handoffPrompt(task: TaskRow, prompt: string, evidence: unknown): string {
  return [
    prompt,
    "",
    "Original task:",
    task.compiledPrompt ?? task.prompt ?? "(none recorded)",
    "",
    "The compiled script stopped here because its guards did not hold. What failed:",
    JSON.stringify(evidence),
    "",
    "The page is exactly where the script left it. Finish the task from here.",
  ].join("\n");
}

export function createCompiledExecutor(deps: CompiledExecutorDeps): TaskExecutor {
  const { pool, gate, blobs, db, endpointFor, llmFor, metrics } = deps;
  const storageFlagsOf = deps.storageFlagsOf ?? defaultStorageFlagsOf;

  return {
    async execute(handle: RunHandle): Promise<RunResult> {
      let lease: EndpointLease | undefined;
      let session: RunSession | undefined;
      let deopted = false;
      let ok = false;
      try {
        const script = await getActiveScript(db, handle.task.id);
        if (!script) {
          // Permanent: a task in `compiled` mode with nothing active is a wiring fault, and
          // retrying finds the same empty shelf.
          return { ok: false, error: "no active compiled script for this task", permanent: true };
        }

        lease = await pool.acquire(await endpointFor(handle), handle.run.id);
        if (handle.signal.aborted) return { ok: false, error: "run_cancelled", permanent: true };
        const trace = createTraceRecorder(db, blobs, handle.run.id, storageFlagsOf(handle.task));
        const limits = browserLimitsOf(handle.task);
        session = await openRunSession({
          conn: lease.conn,
          gate,
          taskCtx: { taskId: handle.task.id, runId: handle.run.id },
          trace,
          ...(metrics ? { metrics } : {}),
          ...(limits ? { limits } : {}),
        });

        const emit = makeEmitFn({ db, taskId: handle.task.id, handleEmit: handle.emit, trace });
        const host: CtxHost = {
          session,
          // The same dedupe claim the agent path uses — adapted, not cast. The two `EmitFn`s
          // are declared in packages that do not import each other (S6a's layering note) and
          // they are *not* structurally identical: the agent's third argument is the dedupe
          // key itself, `ctx`'s is an options object. Casting between them handed
          // `makeEmitFn` an object where it expected a string, so every `emitIfNew` in a
          // compiled run claimed the key `emit:<type>:[object Object]` — the first event
          // published and every later one was silently deduped away. Translating the outcome
          // back is the same fix from the other side: a script reads `ok`/`deduped`, which is
          // what `ctx.ts` documents, not the agent loop's `outcome` string.
          emit: async (type, packet, opts) => {
            const result = await emit(type, packet, opts?.dedupeKey);
            if (result.outcome === "published") return { ok: true, eventId: result.eventId };
            if (result.outcome === "deduped") return { ok: true, deduped: true };
            return { ok: false, error: result.error };
          },
          state: taskStateStore(db, handle),
        };

        const compatibility = asRecord(asRecord(script.guardsMeta)?.compatibility);
        const browserVersion = await withAutomationControl(lease.conn, () => lease!.conn.version(), handle.signal);
        const compatible = compatibility?.runtimeVersion === SCRIPT_RUNTIME_VERSION && compatibility?.browserVersion === browserVersion;
        if (!compatible) {
          await db.transaction(async (trx) => {
            await assertRunLease(trx, handle.run.id, handle.run.leaseGeneration);
            await invalidateScript(trx, script.id);
            await trx.update(tasks).set({ mode: "ai", cleanAiRuns: 0 }).where(eq(tasks.id, handle.task.id));
          });
        }
        const result = compatible ? await runCompiledScript(script.source, host, {
          ...staticRtLimitsOf(handle.task),
          signal: handle.signal,
          ...(metrics ? { metrics } : {}),
        }) : { outcome: "deopt" as const, prompt: "The browser or script runtime changed. Start from fresh perception; no compiled actions have run.",
          evidence: { reason: "runtime_incompatible", expected: compatibility ?? null, actual: { browserVersion, runtimeVersion: SCRIPT_RUNTIME_VERSION } } };

        if (result.outcome === "completed") {
          ok = true;
          return { ok: true };
        }
        if (result.outcome === "killed") {
          return { ok: false, error: `compiled script killed: ${result.reason}` };
        }
        if (result.outcome === "error") {
          return { ok: false, error: `compiled script threw: ${result.error}` };
        }

        // -- deopt: the same run, continued by the agent ---------------------------------
        deopted = true;
        metrics?.deopts.add({ trigger: compatible ? "guard_failure" : "runtime_incompatible" });
        await trace.record("action", {
          action: "deopt",
          trigger: compatible ? "guard_failure" : "runtime_incompatible",
          evidence: result.evidence,
          ok: true,
        });

        const [emits, trigger] = await Promise.all([handle.declaredEmits(), triggerInfoOf(db, handle)]);
        const control = browserLoopControl(db, handle, lease.conn, session);
        const loop = await runAgentLoop({
          llm: llmFor({ trace, task: handle.task, runId: handle.run.id }),
          tools: buildToolRegistry({ session, emit, destination: handle.destination, requestHumanAction: handle.requestHumanAction, checkpoint: control.checkpoint, progress: control.progress, memory: control.memory, actions: control.actions, recordOutcome: handle.recordOutcome, recordCompletionError: handle.recordCompletionError, beforeCall: control.beforeStep, signal: handle.signal, trace }),
          task: { prompt: handoffPrompt(handle.task, result.prompt, result.evidence) },
          trigger,
          emits,
          trace,
          maxInputTokens: maxInputTokensOf(handle.task),
          beforeStep: control.beforeStep, checkpoint: control.checkpoint, memory: control.memory, actions: control.actions,
          initialPerception: async () => await control.beforeStep() ?? summarizePerception(await withAutomationControl(lease!.conn, () => session!.page.perceive({elementLimit:50}), handle.signal)),
          signal: handle.signal,
        });
        const runResult = toRunResult(loop);
        ok = runResult.ok;
        if (ok) {
          // The fresh trace is what S6b recompiles from — the self-healing half of the loop.
          await trace.record("action", { action: "deopt_recovery", ok: true });
        }
        return runResult;
      } catch (err) {
        if (err instanceof AppError && err.code === "human_action_pending") return { ok: false, error: err.message, suspended: true };
        if (err instanceof AppError && err.code === "agent_no_progress") return { ok: false, error: err.message, permanent: true };
        if (err instanceof AppError && err.code === "no_endpoint_configured") {
          return { ok: false, error: "no_endpoint_configured", permanent: true };
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        await session?.close().catch(() => undefined);
        await lease?.release().catch(() => undefined);
        await deps.onOutcome?.({ task: handle.task, run: handle.run, deopted, ok }).catch(() => undefined);
      }
    },
  };
}

/** Re-exported so a composition root wiring this executor gets the table it counts on. */
export { tasks };
