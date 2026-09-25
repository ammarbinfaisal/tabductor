import { createContextHistory } from "./context-history.js";
import { acquireBrowserContinuity, type BrowserContinuity } from "./browser-continuity.js";
import type { PythonRunner } from "./python-runner.js";
import { createRunWorkspace } from "./workspace.js";
import { withAutomationControl } from "@tabductor/browser";
import { AppError, browserArtifactKey, SCRIPT_RUNTIME_VERSION } from "@tabductor/core";
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
import { getActiveScript, invalidateScript, isPlannedDeopt } from "@tabductor/compiler";
import { tasks, type Db, type RunRow, type TaskRow } from "@tabductor/db";
import { assertRunLease, browserOperatingPrompt, latestBrowserPrompt, type RunHandle, type RunResult, type TaskExecutor } from "@tabductor/engine";
import type { PolicyGate } from "@tabductor/core";
import { type ScriptRunResult, type HelperRevision } from "@tabductor/static-rt";
import type { Metrics } from "@tabductor/telemetry";
import { eq } from "drizzle-orm";
import type { AgentExecutorDeps } from "./executor.js";
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
import { buildBrowserCodeTools } from "./tools.js";
import { browserHelperStore } from "./browser-helpers.js";
import { browserLoopControl } from "./browser-loop-control.js";

/**
 * `(browser, compiled)` — the fast path, and the door back to the slow one.
 *
 * A clean compiled run makes **no model call at all**: the script drives the page through the
 * same SDK host as the agent; every crossing lands on the same policy and lease fences,
 * and the trace it leaves has zero `llm` entries. That absence is the product's core claim,
 * and the flagship test asserts it rather than trusting it.
 *
 * When the guards fail, `workflow.deopt` does **not** fail the run. The same run row continues under
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

export type CompiledExecutorDeps = Pick<AgentExecutorDeps, "secrets" | "registerSecretRun" | "captchaFor"> & {
  pythonRunner?: AgentExecutorDeps["pythonRunner"];
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
  onOutcome?: (input: { task: TaskRow; run: RunRow; deopted: boolean; plannedDeopted?: boolean; ok: boolean;
    scriptId?: string; scriptKey?: string; deoptKey?: string }) => Promise<void>;
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

/** What the agent wakes up to. The compiler wrote the first paragraph for exactly this moment. */
function handoffPrompt(task: TaskRow, prompt: string, evidence: unknown, planned: boolean): string {
  return [
    task.compiledPrompt ?? task.prompt ?? "(none recorded)",
    "",
    "## Current deopt handoff",
    prompt,
    "",
    planned
      ? "The compiled script intentionally completed its deterministic prefix and delegated the remaining runtime judgment to you."
      : "The compiled script stopped here because its guards did not hold. What failed:",
    JSON.stringify(evidence),
    "",
    "The page is exactly where the script left it. Finish the task from here without replaying acknowledged work.",
  ].join("\n");
}

export function createCompiledExecutor(deps: CompiledExecutorDeps): TaskExecutor {
  const { pool, gate, blobs, db, endpointFor, llmFor, metrics } = deps;
  const storageFlagsOf = deps.storageFlagsOf ?? defaultStorageFlagsOf;

  return {
    async execute(handle: RunHandle): Promise<RunResult> {
      let lease: EndpointLease | undefined;
      let session: RunSession | undefined;
      let unregisterSecretRun: (() => void) | undefined;
      let deopted = false;
      let plannedDeopted = false;
      let scriptId: string | undefined, scriptKey: string | undefined, deoptKey: string | undefined;
      let ok = false;
      let pythonRunner: PythonRunner | undefined;
      let continuity: BrowserContinuity | undefined;
      try {
        const script = await getActiveScript(db, handle.task.id);
        if (!script) {
          // Permanent: a task in `compiled` mode with nothing active is a wiring fault, and
          // retrying finds the same empty shelf.
          return { ok: false, error: "no active compiled script for this task", permanent: true };
        }
        scriptId = script.id;
        scriptKey = browserArtifactKey(script);

        continuity = await acquireBrowserContinuity(db, handle, "python");
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

        unregisterSecretRun = deps.registerSecretRun?.(handle.run.id, { session, trace });
        const emit = makeEmitFn({ db, taskId: handle.task.id, handleEmit: handle.emit, trace });
        const compatibility = asRecord(asRecord(script.guardsMeta)?.compatibility);
        const browserVersion = await withAutomationControl(lease.conn, () => lease!.conn.version(), handle.signal);
        const compatible = compatibility?.runtimeVersion === SCRIPT_RUNTIME_VERSION && compatibility?.browserVersion === browserVersion && asRecord(script.guardsMeta)?.language === "python" && asRecord(script.guardsMeta)?.apiVersion === "playwright-python-v1";
        if (!compatible) {
          await db.transaction(async (trx) => {
            await assertRunLease(trx, handle.run.id, handle.run.leaseGeneration);
            await trx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, handle.task.id)).for("update");
            if ((await getActiveScript(trx, handle.task.id))?.id === script.id) {
              await invalidateScript(trx, script.id);
              await trx.update(tasks).set({ mode: "ai", cleanAiRuns: 0 }).where(eq(tasks.id, handle.task.id));
            }
          });
        }
        const [emits, trigger] = await Promise.all([handle.declaredEmits(), triggerInfoOf(db, handle)]);
        const control = browserLoopControl(db, handle, lease.conn, session);
        const workspace = createRunWorkspace(blobs, continuity?.workspace ?? control.workspace, trace);
        const contextHistory = createContextHistory(blobs, continuity?.context ?? control.context);
        const memory = continuity?.memory ?? control.memory;
        pythonRunner = deps.pythonRunner?.open?.({runId:handle.run.id,leaseGeneration:handle.run.leaseGeneration}) ?? deps.pythonRunner;
        const sdkDeps = { session, emit, workspace, storageFlags: storageFlagsOf(handle.task), captcha: deps.captchaFor?.(handle), recordInput: handle.recordInput,
          ...(deps.secrets ? { fillSecret: (name: string, anchor: string) => deps.secrets!.fill(handle.run.id, name, anchor) } : {}),
          evidenceScope: {taskId:handle.task.id,contentHash:handle.task.contentHash},
          input: trigger?.packet, helpers: browserHelperStore(db, handle, "python"),
          contextHistory, checkpoint: control.checkpoint, progress: control.progress, memory, actions: control.actions,
          recordOutcome: handle.recordOutcome, recordCompletionError: handle.recordCompletionError,
          beforeCall: control.beforeStep, signal: handle.signal, trace,
          llm: llmFor({ trace, task: handle.task, runId: handle.run.id }) };
        const runSdk = async (): Promise<ScriptRunResult & { plannedDeopt?: boolean }> => {
          const code = buildBrowserCodeTools({ ...sdkDeps, pythonRunner, compiled: true, memoryMb: staticRtLimitsOf(handle.task).memoryMb,
            pinnedHelpers: (asRecord(script.guardsMeta)?.helpers ?? []) as HelperRevision[] })[0]!;
          handle.signal.throwIfAborted();
          const result = await code.execute({source:script.source,timeoutMs:Math.min(180000,staticRtLimitsOf(handle.task).wallClockMs ?? 180000)},handle.signal);
          if (result.terminal?.outcome === "done") return {outcome:"completed"};
          if (result.terminal?.outcome === "fail") return {outcome:"error",error:result.terminal.reason};
          if (result.terminal?.outcome === "deopt") {
            const plan = asRecord(asRecord(script.guardsMeta)?.plan);
            const plannedDeopt = isPlannedDeopt(plan, result.terminal.evidence);
            deoptKey = plannedDeopt ? `planned:${String(asRecord(result.terminal.evidence)?.plannedDeopt)}` : "recovery";
            return {outcome:"deopt",
              prompt:plannedDeopt ? result.terminal.reason : [plan?.recoveryPrompt,result.terminal.reason].filter(Boolean).join("\n"),
              evidence:{guard:result.terminal.evidence},
              plannedDeopt};
          }
          return {outcome:"deopt",prompt:"Continue from the current page and prior tool results. Do not repeat completed actions.",
            evidence:{reason:result.ok?"Program returned without completing the task":result.error}};
        };
        const result = compatible ? await runSdk() : { outcome: "deopt" as const, prompt: "The browser or script runtime changed. Start from fresh perception; no compiled actions have run.",
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
        plannedDeopted = result.plannedDeopt === true;
        const deoptTrigger = plannedDeopted ? "planned_ai" : compatible ? "guard_failure" : "runtime_incompatible";
        deoptKey ??= "recovery";
        metrics?.deopts.add({ trigger: deoptTrigger });
        await trace.record("action", {
          action: "deopt",
          trigger: deoptTrigger,
          planned: plannedDeopted,
          scriptId, scriptKey, deoptKey,
          evidence: result.evidence,
          ok: true,
        });

        const operating = await browserOperatingPrompt(db, handle.task);
        const learnedDeopt = compatible ? await latestBrowserPrompt(db, handle.task.id, handle.task.contentHash, "deopt", `${scriptKey}:${deoptKey}`) : undefined;
        await trace.record("runtime", { action: "browser.prompt", lane: "deopt", revision: operating.revision,
          deoptRevision: learnedDeopt?.revision ?? null, scriptId, deoptKey });
        const recoveryPrompt = learnedDeopt ? `${learnedDeopt.prompt}\n\nCurrent compiled handoff:\n${result.prompt}` : result.prompt;
        const loop = await runAgentLoop({
          llm: llmFor({ trace, task: handle.task, runId: handle.run.id }),
          tools: buildBrowserCodeTools({ ...sdkDeps, pythonRunner, workspace,
            helpers: browserHelperStore(db, handle, "python") }),
          task: { prompt: handoffPrompt({ ...handle.task, compiledPrompt: operating.prompt }, recoveryPrompt, result.evidence, plannedDeopted) },
          trigger,
          emits,
          trace,
          maxInputTokens: maxInputTokensOf(handle.task),
          browserContinuation: continuity?.handoff,
          contextHistory,
          beforeStep: control.beforeStep,
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
        if (err instanceof AppError && err.code === "agent_no_progress") return { ok: false, error: err.message, permanent: true };
        if (err instanceof AppError && err.code === "no_endpoint_configured") {
          return { ok: false, error: "no_endpoint_configured", permanent: true };
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        unregisterSecretRun?.();
        await pythonRunner?.close?.().catch(() => undefined);
        await session?.close().catch(() => undefined);
        await lease?.release().catch(() => undefined);
        await continuity?.release(ok).catch(() => undefined);
        await deps.onOutcome?.({ task: handle.task, run: handle.run, deopted, plannedDeopted, ok, scriptId, scriptKey, deoptKey }).catch(() => undefined);
      }
    },
  };
}

/** Re-exported so a composition root wiring this executor gets the table it counts on. */
export { tasks };
