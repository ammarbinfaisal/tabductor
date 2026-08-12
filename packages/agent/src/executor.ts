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
import { taskState, type Db, type TaskRow } from "@tabductor/db";
import { readEventSchemas, type RunHandle, type RunResult, type TaskExecutor } from "@tabductor/engine";
import type { PolicyGate } from "@tabductor/policy";
import type { Metrics } from "@tabductor/telemetry";
import { and, eq } from "drizzle-orm";
import type { Llm } from "./llm.js";
import { runAgentLoop, type AgentLoopResult, type TriggerInfo } from "./loop.js";
import type { EmitFn, EmitOutcome } from "./tools.js";

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

const defaultStorageFlagsOf = (task: TaskRow): StorageFlags => asStorageFlags(task.limitsJson);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStorageFlags(limitsJson: unknown): StorageFlags {
  const storage = asRecord(asRecord(limitsJson)?.storage);
  return storage ?? {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

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

/** `limits_json.agent.max_steps` — `undefined` lets `runAgentLoop` apply its own default
 * (§ spec: "Step budget from `limits_json.agent.max_steps` (default 30)"), one default kept
 * in one place rather than restated here. */
function maxStepsOf(task: TaskRow): number | undefined {
  const agent = asRecord(asRecord(task.limitsJson)?.agent);
  const maxSteps = agent ? asNumber(agent.max_steps) : undefined;
  return maxSteps !== undefined && maxSteps > 0 ? maxSteps : undefined;
}

async function triggerInfoOf(db: Db, handle: RunHandle): Promise<TriggerInfo | null> {
  if (!handle.trigger) return null;
  // One `event_defs` row per (workflow_version_id, event_type) — the run's *pinned* version,
  // exactly like every other schema lookup in this codebase (packet-schema.ts's own query).
  const schemas = await readEventSchemas(db, handle.task.workflowVersionId);
  return { type: handle.trigger.type, packet: handle.trigger.packet, schema: schemas[handle.trigger.type] ?? {} };
}

/**
 * `emit(type, packet, {dedupeKey})`'s host half (deliverable 3): the tool only decides *what*
 * to publish, this decides *whether* — claim the dedupe key first (an atomic unique insert,
 * the same `claim`-then-act shape `packages/bus/src/dedupe.ts` uses for inbound redelivery,
 * applied here to outbound side effects instead), then publish. A publish that fails
 * validation releases the claim, so a corrected retry within the same run's step budget can
 * still emit under that key — claiming before a validation outcome is known would otherwise
 * burn the key on a packet that was never actually sent.
 */
function makeEmitFn(opts: { db: Db; taskId: string; handleEmit: RunHandle["emit"]; trace: TraceRecorder }): EmitFn {
  const { db, taskId, handleEmit, trace } = opts;

  const publish = async (type: string, packet: unknown, dedupeKey: string | undefined): Promise<EmitOutcome> => {
    try {
      const event = await handleEmit(type, packet);
      await trace.record("action", { action: "emit", type, dedupeKey: dedupeKey ?? null, ok: true, eventId: event.eventId });
      return { outcome: "published", eventId: event.eventId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await trace.record("action", { action: "emit", type, dedupeKey: dedupeKey ?? null, ok: false, error });
      return { outcome: "rejected", error };
    }
  };

  return async (type, packet, dedupeKey) => {
    if (dedupeKey === undefined) return publish(type, packet, undefined);

    const key = `emit:${type}:${dedupeKey}`;
    const claimed = await db
      .insert(taskState)
      .values({ taskId, key, value: {} })
      .onConflictDoNothing()
      .returning({ taskId: taskState.taskId });
    if (claimed.length === 0) {
      await trace.record("action", { action: "emit", type, dedupeKey, ok: true, deduped: true });
      return { outcome: "deduped" };
    }

    const result = await publish(type, packet, dedupeKey);
    if (result.outcome === "rejected") {
      await db.delete(taskState).where(and(eq(taskState.taskId, taskId), eq(taskState.key, key))).catch(() => undefined);
    }
    return result;
  };
}

function toRunResult(result: AgentLoopResult): RunResult {
  switch (result.outcome) {
    case "done":
      return { ok: true };
    case "fail":
      return { ok: false, error: result.reason };
    case "step_budget_exceeded":
      // Retryable, not permanent — the deviation from S3b's `resource_limit_exceeded`
      // precedent, argued in the S4b subphase doc: a script hitting a fixed resource cap
      // replays into the identical wall on retry, but an LLM's sampling differs attempt to
      // attempt, so a retried run can plausibly finish inside the same step budget where the
      // first one didn't. Same class as `browser.disconnected`/`endpoint_queue_full`.
      return { ok: false, error: "step_budget_exceeded" };
  }
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

        const result = await runAgentLoop({
          llm,
          session,
          task: { prompt: handle.task.prompt },
          trigger,
          emits,
          emit,
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
