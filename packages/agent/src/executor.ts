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
import type { Db, TaskRow } from "@tabductor/db";
import type { RunHandle, RunResult, TaskExecutor } from "@tabductor/engine";
import type { PolicyGate } from "@tabductor/policy";
import type { Metrics } from "@tabductor/telemetry";
import { asNumber, asRecord, makeEmitFn, maxStepsOf, storageFlagsOf as defaultStorageFlagsOf, toRunResult, triggerInfoOf } from "./executor-shared.js";
import type { Llm } from "./llm.js";
import { runAgentLoop } from "./loop.js";
import { buildToolRegistry } from "./tools.js";

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
  pool: EndpointPool;
  gate: PolicyGate;
  blobs: BlobStore;
  /** For the per-run `TraceRecorder` — the executor does not own a DB connection. */
  db: Db;
  /** Same reasoning as `ScriptedExecutorDeps.defaultEndpointId`: no per-task/per-user endpoint
   * model exists yet, so one explicitly-injected id stands in for "the endpoint this executor
   * talks to" until S5a-era work gives tasks their own. */
  defaultEndpointId: string;
  /**
   * Builds the per-run `Llm`, wired to that run's own trace recorder — a fresh completion
   * transport per run, not one shared client, because tracing is per-run (S4a's `withTrace`
   * needs *this* run's recorder) and, for replay in tests, transcript position is per-run too.
   * `task` rides along so a test rig can pick a fixture per task; production wiring ignores it
   * (one live provider serves every task).
   */
  llmFor: (opts: { trace: TraceRecorder; task: TaskRow }) => Llm;
  metrics?: Metrics;
  storageFlagsOf?: (task: TaskRow) => StorageFlags;
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
    if (err.code === "endpoint_queue_full") return { ok: false, error: "endpoint_queue_full" };
    return { ok: false, error: err.message };
  }
  if (lease && (await connectionIsDead(lease))) return { ok: false, error: "browser.disconnected" };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function createAgentExecutor(deps: AgentExecutorDeps): TaskExecutor {
  const { pool, gate, blobs, db, defaultEndpointId, llmFor, metrics } = deps;
  const storageFlagsOf = deps.storageFlagsOf ?? defaultStorageFlagsOf;

  return {
    async execute(handle: RunHandle): Promise<RunResult> {
      let lease: EndpointLease | undefined;
      let session: RunSession | undefined;
      try {
        lease = await pool.acquire(defaultEndpointId, handle.run.id);
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

        const [emits, trigger] = await Promise.all([handle.declaredEmits(), triggerInfoOf(db, handle)]);
        const emit = makeEmitFn({ db, taskId: handle.task.id, handleEmit: handle.emit, trace });
        const llm = llmFor({ trace, task: handle.task });
        const tools = buildToolRegistry({ session, emit });

        const result = await runAgentLoop({
          llm,
          tools,
          task: { prompt: handle.task.prompt },
          trigger,
          emits,
          trace,
          maxSteps: maxStepsOf(handle.task),
        });
        return toRunResult(result);
      } catch (err) {
        return mapError(err, lease);
      } finally {
        await session?.close().catch(() => undefined);
        await lease?.release().catch(() => undefined);
      }
    },
  };
}
