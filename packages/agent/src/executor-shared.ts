import type { StorageFlags, TraceRecorder } from "@tabductor/browser";
import { AppError } from "@tabductor/core";
import { events, workflowVersions, workflows, type Db, type TaskRow } from "@tabductor/db";
import { assertRunLease, type RunHandle, type RunResult } from "@tabductor/engine";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { AgentLoopResult, TriggerInfo } from "./loop.js";
import type { EmitFn, EmitOutcome } from "./tools.js";

/**
 * What the browser and decision executors share: everything about
 * running `runAgentLoop` behind the engine's `TaskExecutor` contract that has nothing to do
 * with *how* a run's session comes to exist — reading the trigger's compiled schema, the
 * `emit` tool's host half (dedupe-claim then publish), and translating
 * an `AgentLoopResult` into the engine's `RunResult`. A browser run acquires a pool lease and
 * opens a page; a decision run acquires only a store-aware tool registry — everything below this line
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
 * either: a decision run's LLM calls and tool actions are opted in/out exactly like a browser
 * run's. Absent field = on, matching every other storage default in this codebase. */
export function storageFlagsOf(task: TaskRow): StorageFlags {
  const storage = asRecord(asRecord(task.limitsJson)?.storage);
  return storage ?? {};
}

/** Optional total request admission budget, including schemas and image allowance. */
export function maxInputTokensOf(task: TaskRow): number | undefined {
  const value = asNumber(asRecord(asRecord(task.limitsJson)?.agent)?.max_input_tokens);
  return value !== undefined && Number.isSafeInteger(value) && value >= 4096 ? value : undefined;
}

export async function triggerInfoOf(db: Db, handle: RunHandle): Promise<TriggerInfo | null> {
  if (!handle.trigger) return null;
  // One `event_defs` row per (workflow_version_id, event_type) — the run's *pinned* version,
  // exactly like every other schema lookup in this codebase (packet-schema.ts's own query).

  // Root manual events persist the invocation inputs. Read by execution (never latest
  // workflow run), so downstream packets and retries keep the same values.
  const [root] = handle.run.executionId ? await db.select({ packet: events.packet }).from(events)
    .where(and(eq(events.executionId, handle.run.executionId), eq(events.type, "manual.trigger"), isNull(events.sourceRunId)))
    .orderBy(asc(events.occurredAt), asc(events.eventId)).limit(1) : [];
  const promptInputs = asRecord(asRecord(root?.packet)?.promptInputs);
  const packet = promptInputs ? { ...asRecord(handle.trigger.packet), promptInputs } : handle.trigger.packet;
  return { type: handle.trigger.type, packet, schema: {} };
}

/**
 * `emit(type, packet, {dedupeKey})`'s host half (S4b deliverable 3): the tool only decides
 * *what* to publish, this decides *whether* — claim the dedupe key first (an atomic unique
 * insert, the same `claim`-then-act shape `packages/bus/src/dedupe.ts` uses for inbound
 * redelivery, applied here to outbound side effects instead), then publish. A publish that
 * fails validation releases the claim, so a corrected retry within the same run
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
  restorePendingWrites?: (writes: Array<(trx: Db) => Promise<void>>) => void;
  /** Wraps the drained writes into one `RunHandle.emit` `withTx` hook — the writer-role
   * switch belongs to `packages/store` (`flushStagedWrites`), not this file, which only
   * knows *that* something is pending, never how to execute it under the right role. */
  wrapPendingWrites?: (writes: Array<(trx: Db) => Promise<void>>) => (trx: Db) => Promise<void>;
}): EmitFn {
  const { handleEmit, trace } = opts;

  const publish = async (type: string, packet: unknown, dedupeKey: string | undefined): Promise<EmitOutcome> => {
    const pending = opts.drainPendingWrites?.() ?? [];
    let committed = false;
    try {
      const withTx = pending.length > 0 && opts.wrapPendingWrites ? opts.wrapPendingWrites(pending) : undefined;
      const event = await handleEmit(type, packet, {
        ...(withTx ? { withTx } : {}),
        ...(dedupeKey ? { dedupeKey } : {}),
      });
      committed = true;
      if (!event) {
        await trace.record("action", { action: "emit", type, dedupeKey: dedupeKey ?? null, ok: true, deduped: true });
        return { outcome: "deduped" };
      }
      await trace.record("action", { action: "emit", type, dedupeKey: dedupeKey ?? null, ok: true, eventId: event.eventId });
      return { outcome: "published", eventId: event.eventId };
    } catch (err) {
      if (!committed) opts.restorePendingWrites?.(pending);
      const error = err instanceof Error ? err.message : String(err);
      await trace.record("action", { action: "emit", type, dedupeKey: dedupeKey ?? null, ok: false, error });
      return { outcome: "rejected", error };
    }
  };

  return (type, packet, dedupeKey) => publish(type, packet, dedupeKey);
}

/**
 * The safety net `makeEmitFn`'s drain-on-emit cannot cover: a run that staged a store write
 * (`store.insert`/`upsert`) and then finished — `done`/`fail`, cancellation, a
 * thrown error — without ever calling `emit` again. Nothing about §7's ordering rule requires
 * *every* store write to ride an emit; it only requires that when one does accompany an emit,
 * the two are atomic. A write with no emit downstream at all still has to land somewhere, so
 * the executor calls this once, after the loop returns, in its own bare transaction.
 */
export async function flushRemainingWrites(opts: {
  db: Db;
  runId: string;
  leaseGeneration: number;
  drainPendingWrites?: () => Array<(trx: Db) => Promise<void>>;
  wrapPendingWrites?: (writes: Array<(trx: Db) => Promise<void>>) => (trx: Db) => Promise<void>;
}): Promise<void> {
  const pending = opts.drainPendingWrites?.() ?? [];
  if (pending.length === 0 || !opts.wrapPendingWrites) return;
  const withTx = opts.wrapPendingWrites(pending);
  await opts.db.transaction(async (trx) => {
    await assertRunLease(trx, opts.runId, opts.leaseGeneration);
    await withTx(trx);
  });
}

export function toRunResult(result: AgentLoopResult): RunResult {
  switch (result.outcome) {
    case "done":
      return { ok: true };
    case "fail":
      return { ok: false, error: result.reason };
  }
}
