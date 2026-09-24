import { createContextHistory } from "./context-history.js";
import { createRunWorkspace } from "./workspace.js";
import { withAutomationControl } from "@tabductor/browser";
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
import { AppError } from "@tabductor/core";
import type { Db, RunRow, TaskRow } from "@tabductor/db";
import { type RunHandle, type RunResult, type TaskExecutor } from "@tabductor/engine";
import type { PolicyGate } from "@tabductor/core";
import type { SecretsBroker, SecretsBrokerRunDeps } from "@tabductor/secrets";
import type { Metrics } from "@tabductor/telemetry";
import {
  asNumber,
  asRecord,
  makeEmitFn,
  maxInputTokensOf,
  storageFlagsOf as defaultStorageFlagsOf,
  toRunResult,
  triggerInfoOf,
} from "./executor-shared.js";
import type { Llm } from "./llm.js";
import { runAgentLoop } from "./loop.js";
import { buildBrowserCodeTools, summarizePerception } from "./tools.js";
import { browserHelperStore } from "./browser-helpers.js";
import { browserLoopControl } from "./browser-loop-control.js";
import type { PythonRunner } from "./python-runner.js";
import { acquireBrowserContinuity, type BrowserContinuity } from "./browser-continuity.js";

/**
 * `AgentExecutor`: composes the tool registry + loop behind the engine's executor contract
 * (impl-phases Phase 2), pool-acquire → session → loop → release, exactly the shape
 * `ScriptedBrowserExecutor` (testkit) follows for the same reason — the engine, the pool and
 * the trace stack are the thing under test either way, and forking a second acquire/release
 * pattern here would be the only place that shape had to be remembered twice.
 *
 * PRODUCTION code (unlike the scripted executor, which is test-only and lives in
 * `apps/testkit`): this is what `apps/engine/src/main.ts` registers for mode `ai`.
 */

export type AgentExecutorDeps = {
  pythonRunner?: PythonRunner;
  captchaFor?: (handle: RunHandle) => import("@tabductor/engine").CaptchaService;
  pool: EndpointPool;
  gate: PolicyGate;
  blobs: BlobStore;
  /** For the per-run `TraceRecorder` — the executor does not own a DB connection. */
  db: Db;
  /**
   * Which endpoint this run drives (U3a). Production passes `pickWorkflowEndpoint` over the
   * run's workflow — the rotation across the workflow's "Browser endpoints" — and test rigs
   * pass `async () => id`. Resolved per run, never at boot, so adding an endpoint in settings
   * takes effect on the next run. Throwing `no_endpoint_configured` fails the run permanently.
   */
  endpointFor: (handle: RunHandle) => Promise<string>;
  /**
   * Builds the per-run `Llm`, wired to that run's own trace recorder — a fresh completion
   * transport per run, not one shared client, because tracing is per-run (S4a's `withTrace`
   * needs *this* run's recorder) and, for replay in tests, transcript position is per-run too.
   * `task` rides along so a test rig can pick a fixture per task; production wiring ignores it
   * (one live provider serves every task).
   */
  llmFor: (opts: { trace: TraceRecorder; task: TaskRow; runId: string }) => Llm;
  metrics?: Metrics;
  storageFlagsOf?: (task: TaskRow) => StorageFlags;
  /**
   * Called after the run settles inside the executor (the run row is still `running`; the
   * engine finishes it next). The compile loop (`compile-loop.ts`) hangs here: a clean run's
   * trace is what promotion compiles from. Injected so the executor stays a code path.
   */
  onOutcome?: (input: { task: TaskRow; run: RunRow; ok: boolean }) => Promise<void>;
  /** S7 browser secret tool plus the live-session registry the broker resolves through. */
  secrets?: Pick<SecretsBroker, "fill">;
  registerSecretRun?: (runId: string, deps: SecretsBrokerRunDeps) => () => void;
};

/** `limits_json.browser` — same shape and reasoning `ScriptedBrowserExecutor` reads its own
 * copy of (S3b). Absent field = unlimited, matching every other optional cap in this codebase. */
function browserLimitsOf(task: TaskRow): ResourceLimits | undefined {
  const browser = asRecord(asRecord(task.limitsJson)?.browser);
  if (!browser) return undefined;
  return {
    ...(asNumber(browser.max_tabs) !== undefined ? { maxTabs: asNumber(browser.max_tabs) } : {}),
    ...(asNumber(browser.max_visits) !== undefined ? { maxVisits: asNumber(browser.max_visits) } : {}),
    ...(asNumber(browser.max_wall_ms) !== undefined ? { maxWallMs: asNumber(browser.max_wall_ms) } : {}),
  };
}

/**
 * Whatever the in-flight call threw once the connection is actually gone is unstable across
 * Playwright versions (`ScriptedBrowserExecutor`'s own comment on this, verbatim reasoning) —
 * ask the pool's connection whether *it* now considers the endpoint dead instead of
 * pattern-matching the throw.
 */
async function connectionIsDead(lease: EndpointLease, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dead = await lease.conn.version().then(
      () => false,
      (err: unknown) => err instanceof AppError && err.code === "browser.disconnected",
    );
    if (dead || Date.now() >= deadline) return dead;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function mapError(err: unknown, lease: EndpointLease | undefined): Promise<RunResult> {
  if (err instanceof AppError) {
    if (err.code === "browser.disconnected") return { ok: false, error: "browser.disconnected" };
    if (err.code === "resource_limit_exceeded") return { ok: false, error: "resource_limit_exceeded", permanent: true };
    if (err.code === "agent_no_progress") return { ok: false, error: err.message, permanent: true };
    if (err.code === "endpoint_queue_full") return { ok: false, error: "endpoint_queue_full" };
    if (err.code === "no_endpoint_configured") return { ok: false, error: "no_endpoint_configured", permanent: true };
    return { ok: false, error: err.message };
  }
  if (lease && (await connectionIsDead(lease))) return { ok: false, error: "browser.disconnected" };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function createAgentExecutor(deps: AgentExecutorDeps): TaskExecutor {
  const { pool, gate, blobs, db, endpointFor, llmFor, metrics } = deps;
  const storageFlagsOf = deps.storageFlagsOf ?? defaultStorageFlagsOf;

  return {
    async execute(handle: RunHandle): Promise<RunResult> {
      let lease: EndpointLease | undefined;
      let session: RunSession | undefined;
      let unregisterSecretRun: (() => void) | undefined;
      let ok = false;
      let pythonRunner: PythonRunner | undefined;
      let continuity: BrowserContinuity | undefined;
      try {
        continuity = await acquireBrowserContinuity(db, handle, "python");
        lease = await pool.acquire(await endpointFor(handle), handle.run.id);
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

        const [emits, trigger] = await Promise.all([handle.declaredEmits(), triggerInfoOf(db, handle)]);
        const emit = makeEmitFn({ db, taskId: handle.task.id, handleEmit: handle.emit, trace });
        const llm = llmFor({ trace, task: handle.task, runId: handle.run.id });
        const control = browserLoopControl(db, handle, lease.conn, session);
        const workspace = createRunWorkspace(blobs, continuity?.workspace ?? control.workspace, trace);
        const contextHistory = createContextHistory(blobs, continuity?.context ?? control.context);
        const memory = continuity?.memory ?? control.memory;
        pythonRunner = deps.pythonRunner?.open?.({runId:handle.run.id,leaseGeneration:handle.run.leaseGeneration}) ?? deps.pythonRunner;
        const tools = buildBrowserCodeTools({
          storageFlags: storageFlagsOf(handle.task),
          evidenceScope: {taskId:handle.task.id,contentHash:handle.task.contentHash},
          input: trigger?.packet, helpers: browserHelperStore(db, handle, "python"), pythonRunner, workspace,
          session,
          emit,
          captcha: deps.captchaFor?.(handle), recordInput: handle.recordInput,
          contextHistory, checkpoint: control.checkpoint, progress: control.progress, memory, actions: control.actions, recordOutcome: handle.recordOutcome, recordCompletionError: handle.recordCompletionError, beforeCall: control.beforeStep, signal: handle.signal, trace,
          ...(deps.secrets
            ? { fillSecret: (secretName, anchor) => deps.secrets!.fill(handle.run.id, secretName, anchor) }
            : {}),
        });

        const storedPrompt = handle.task.compiledPrompt ?? handle.task.prompt;
        const result = await runAgentLoop({
          llm,
          tools,
          task: { prompt: storedPrompt },
          trigger,
          emits,
          trace,
          maxInputTokens: maxInputTokensOf(handle.task),
          browserContinuation: continuity?.handoff,
          contextHistory, progress: control.progress, beforeStep: control.beforeStep, checkpoint: control.checkpoint, memory, actions: control.actions,
          initialPerception: async () => await control.beforeStep() ?? summarizePerception(await withAutomationControl(lease!.conn, () => session!.page.perceive({elementLimit:50}), handle.signal)),
          signal: handle.signal,
        });
        const runResult = toRunResult(result);
        ok = runResult.ok;
        return runResult;
      } catch (err) {
        return mapError(err, lease);
      } finally {
        unregisterSecretRun?.();
        await pythonRunner?.close?.().catch(() => undefined);
        // Session first, so the trace is flushed before anyone reads it to compile from.
        await session?.close().catch(() => undefined);
        await lease?.release().catch(() => undefined);
        await continuity?.release(ok).catch(() => undefined);
        await deps.onOutcome?.({ task: handle.task, run: handle.run, ok }).catch(() => undefined);
      }
    },
  };
}
