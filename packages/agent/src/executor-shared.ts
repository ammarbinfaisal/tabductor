import type { StorageFlags, TraceRecorder } from "@tabductor/browser";
import { AppError } from "@tabductor/core";
import { taskState, workflowVersions, workflows, type Db, type TaskRow } from "@tabductor/db";
import { readEventSchemas, type RunHandle, type RunResult } from "@tabductor/engine";
import { and, eq } from "drizzle-orm";
import type { AgentLoopResult, TriggerInfo } from "./loop.js";
import type { EmitFn, EmitOutcome } from "./tools.js";

/**
 * What `AgentExecutor` (browser) and `AssetExecutor`'s real path (S5c) share: everything about
 * running `runAgentLoop` behind the engine's `TaskExecutor` contract that has nothing to do
 * with *how* a run's session comes to exist — reading the trigger's compiled schema, the
 * `emit` tool's host half (dedupe-claim then publish), the step-budget limit, and translating
 * an `AgentLoopResult` into the engine's `RunResult`. A browser run acquires a pool lease and
 * opens a page; an asset run acquires nothing but a tool registry — everything below this line
 * is the part that was never about a page to begin with.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** `limits_json.storage` — every kind's trace goes through the identical `StorageFlags`
 * opt-out mechanism (`packages/browser/src/trace.ts`), so reading them is not browser-specific
 * either: an asset run's LLM calls and tool actions are opted in/out exactly like a browser
 * run's. Absent field = on, matching every other storage default in this codebase. */
export function storageFlagsOf(task: TaskRow): StorageFlags {
  const storage = asRecord(asRecord(task.limitsJson)?.storage);
  return storage ?? {};
}

/** `limits_json.agent.max_steps` — `undefined` lets `runAgentLoop` apply its own default, one
 * default kept in one place rather than restated at every call site. */
export function maxStepsOf(task: TaskRow): number | undefined {
  const agent = asRecord(asRecord(task.limitsJson)?.agent);
  const maxSteps = agent ? asNumber(agent.max_steps) : undefined;
  return maxSteps !== undefined && maxSteps > 0 ? maxSteps : undefined;
}

/**
 * A `RunHandle` carries `task.workflow_version_id`, not `user_id` directly — every per-user
 * lookup a `mode=ai` executor needs (the MCP server list for `AssetExecutor`, the asset-store
 * namespace `page.upload` resolves an asset ref against for `AgentExecutor`, S5f) makes this
 * exact join, so it lives here once rather than once per executor (`asset-executor.ts` was
 * S5c's only caller before S5f gave the browser executor a second reason to need it).
 * `packages/secrets/src/broker.ts`'s `resolveSecretForRun` makes the identical join for the
 * identical reason.
 */
export async function userIdForTask(db: Db, workflowVersionId: string): Promise<string> {
  const rows = await db
    .select({ userId: workflows.userId })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(workflowVersions.id, workflowVersionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new AppError("task_workflow_not_found", `no workflow found for workflow_version ${workflowVersionId}`, {
      details: { workflowVersionId },
    });
  }
  return row.userId;
}

export async function triggerInfoOf(db: Db, handle: RunHandle): Promise<TriggerInfo | null> {
  if (!handle.trigger) return null;
  // One `event_defs` row per (workflow_version_id, event_type) — the run's *pinned* version,
  // exactly like every other schema lookup in this codebase (packet-schema.ts's own query).
  const schemas = await readEventSchemas(db, handle.task.workflowVersionId);
  return { type: handle.trigger.type, packet: handle.trigger.packet, schema: schemas[handle.trigger.type] ?? {} };
}

/**
 * `emit(type, packet, {dedupeKey})`'s host half (S4b deliverable 3): the tool only decides
 * *what* to publish, this decides *whether* — claim the dedupe key first (an atomic unique
 * insert, the same `claim`-then-act shape `packages/bus/src/dedupe.ts` uses for inbound
 * redelivery, applied here to outbound side effects instead), then publish. A publish that
 * fails validation releases the claim, so a corrected retry within the same run's step budget
 * can still emit under that key — claiming before a validation outcome is known would
 * otherwise burn the key on a packet that was never actually sent.
 */
export function makeEmitFn(opts: {
  db: Db;
  taskId: string;
  handleEmit: RunHandle["emit"];
  trace: TraceRecorder;
  /**
   * S5g: a store write staged by `store.insert`/`upsert` since the last emit has nowhere to
   * commit on its own — a tool call is not a transaction boundary. Draining here (rather
   * than at the call site) means every emit this run makes, dedupe-deduped or not, gets a
   * chance to fold in whatever is pending: the exact ordering rule graph-compilation-llm §7
   * spells out ("visited is upserted... in the same transaction as its emit"), made to hold
   * for *whichever* emit call happens to be next rather than only a specifically-named one.
   * Absent for a browser run — a browser task has no store tools to have staged anything.
   */
  drainPendingWrites?: () => Array<(trx: Db) => Promise<void>>;
  /** Wraps the drained writes into one `RunHandle.emit` `withTx` hook — the writer-role
   * switch belongs to `packages/store` (`flushStagedWrites`), not this file, which only
   * knows *that* something is pending, never how to execute it under the right role. */
  wrapPendingWrites?: (writes: Array<(trx: Db) => Promise<void>>) => (trx: Db) => Promise<void>;
}): EmitFn {
  const { db, taskId, handleEmit, trace } = opts;

  const publish = async (type: string, packet: unknown, dedupeKey: string | undefined): Promise<EmitOutcome> => {
    try {
      const pending = opts.drainPendingWrites?.() ?? [];
      const withTx = pending.length > 0 && opts.wrapPendingWrites ? opts.wrapPendingWrites(pending) : undefined;
      const event = await handleEmit(type, packet, withTx ? { withTx } : undefined);
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

/**
 * The safety net `makeEmitFn`'s drain-on-emit cannot cover: a run that staged a store write
 * (`store.insert`/`upsert`) and then finished — `done`/`fail`, step-budget exhaustion, a
 * thrown error — without ever calling `emit` again. Nothing about §7's ordering rule requires
 * *every* store write to ride an emit; it only requires that when one does accompany an emit,
 * the two are atomic. A write with no emit downstream at all still has to land somewhere, so
 * the executor calls this once, after the loop returns, in its own bare transaction.
 */
export async function flushRemainingWrites(opts: {
  db: Db;
  drainPendingWrites?: () => Array<(trx: Db) => Promise<void>>;
  wrapPendingWrites?: (writes: Array<(trx: Db) => Promise<void>>) => (trx: Db) => Promise<void>;
}): Promise<void> {
  const pending = opts.drainPendingWrites?.() ?? [];
  if (pending.length === 0 || !opts.wrapPendingWrites) return;
  const withTx = opts.wrapPendingWrites(pending);
  await opts.db.transaction((trx) => withTx(trx));
}

export function toRunResult(result: AgentLoopResult): RunResult {
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
