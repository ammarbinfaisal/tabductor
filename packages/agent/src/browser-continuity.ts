import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { runs, runRecordOutcomes, taskState, type Db } from "@tabductor/db";
import { AppError } from "@tabductor/core";
import { assertRunLease, type RunHandle } from "@tabductor/engine";
import type { CheckpointStore } from "./batch-tools.js";

type Owner = { runId: string; generation: number; recordKey: string | null };
type LastAttempt = Owner & { outcome: "completed" | "interrupted"; recordStatus?: string; reason?: string };
type LeaseState = { owner?: Owner; previous?: LastAttempt };

export type BrowserContinuity = {
  context: CheckpointStore; workspace: CheckpointStore; memory: CheckpointStore;
  handoff: { runId: string; recordKey: string | null; previous: LastAttempt | null; resumed: boolean };
  release: (ok: boolean) => Promise<void>;
};

/** Acquire BEFORE the browser/tab lease in both executors. Per-record progress and
 * verification never use these shared stores. A dead run can be replaced, but cannot
 * subsequently read or write the new owner's state, even on another engine process. */
export async function acquireBrowserContinuity(db: Db, handle: RunHandle,
  language: "python" | "javascript"): Promise<BrowserContinuity | undefined> {
  if (!handle.run.executionId || handle.task.kind !== "browser") return undefined;
  const scope = createHash("sha256").update(JSON.stringify({ executionId: handle.run.executionId,
    contentHash: handle.task.contentHash, apiVersion: "playwright-python-v1", language })).digest("hex");
  const prefix = `browser:${scope}`, leaseKey = `${prefix}:lease`;
  const where = (key: string) => and(eq(taskState.taskId, handle.task.id), eq(taskState.key, key));
  const identity = handle.recordInput?.packet[handle.recordInput.key];
  const owner: Owner = { runId: handle.run.id, generation: handle.run.leaseGeneration,
    recordKey: identity === undefined || identity === null ? null : String(identity).slice(0, 2000) };
  const owns = (state: LeaseState) => state.owner?.runId === owner.runId && state.owner.generation === owner.generation;
  let handoff: BrowserContinuity["handoff"] | undefined;
  while (!handoff) {
    handle.signal.throwIfAborted();
    handoff = await db.transaction(async trx => {
      await assertRunLease(trx, owner.runId, owner.generation);
      await trx.insert(taskState).values({ taskId: handle.task.id, key: leaseKey, value: {} }).onConflictDoNothing();
      const [row] = await trx.select({ value: taskState.value }).from(taskState).where(where(leaseKey)).for("update");
      const state = row!.value as LeaseState;
      if (state.owner) {
        const [active] = await trx.select({ status: runs.status }).from(runs).where(and(eq(runs.id, state.owner.runId),
          eq(runs.leaseGeneration, state.owner.generation)));
        // Same owner cannot acquire twice either: a second executor must wait for release.
        if (active && ["running", "awaiting_approval", "awaiting_human"].includes(active.status)) return undefined;
      }
      const previous: LastAttempt | undefined = state.owner ? { ...state.owner, outcome: "interrupted" } : state.previous;
      await trx.update(taskState).set({ value: { owner, previous } }).where(where(leaseKey));
      if (previous?.runId !== owner.runId) {
        const [memory] = await trx.select({ value: taskState.value }).from(taskState).where(where(`${prefix}:memory`));
        if (memory?.value && typeof memory.value === "object" && !Array.isArray(memory.value)) {
          // Repeated-action detection is local to a record; retained facts/pending work
          // are historical evidence. The shared archive retains all old interactions.
          const { interactions: _interactions, ...knowledge } = memory.value as Record<string, unknown>;
          await trx.update(taskState).set({ value: knowledge }).where(where(`${prefix}:memory`));
        }
      }
      return { runId: owner.runId, recordKey: owner.recordKey, previous: previous ?? null,
        resumed: previous?.runId === owner.runId };
    });
    if (!handoff) await delay(250, undefined, { signal: handle.signal });
  }
  const checkOwner = async (trx: Db) => {
    await assertRunLease(trx, owner.runId, owner.generation);
    const [row] = await trx.select({ value: taskState.value }).from(taskState).where(where(leaseKey)).for("update");
    if (!row || !owns(row.value as LeaseState)) throw new AppError("browser_context_lease_lost", "Browser context belongs to another run");
  };
  const store = (name: string): CheckpointStore => ({
    get: () => db.transaction(async trx => {
      await checkOwner(trx);
      const [row] = await trx.select({ value: taskState.value }).from(taskState).where(where(`${prefix}:${name}`));
      return row?.value ?? null;
    }),
    set: async value => {
      if (JSON.stringify(value).length > 24000) throw new Error("browser state exceeds 24000 characters");
      await db.transaction(async trx => {
        await checkOwner(trx);
        await trx.insert(taskState).values({ taskId: handle.task.id, key: `${prefix}:${name}`, value: value as Record<string, unknown> })
          .onConflictDoUpdate({ target: [taskState.taskId, taskState.key], set: { value: value as Record<string, unknown> } });
      });
    },
  });
  return { context: store("context"), workspace: store("workspace"), memory: store("memory"), handoff,
    async release(ok) {
      // Release also works after cancellation. A stale release must never clear a new owner.
      await db.transaction(async trx => {
        const [row] = await trx.select({ value: taskState.value }).from(taskState).where(where(leaseKey)).for("update");
        if (!row || !owns(row.value as LeaseState)) return;
        const [outcome] = await trx.select({ status: runRecordOutcomes.status, reason: runRecordOutcomes.reason }).from(runRecordOutcomes)
          .where(eq(runRecordOutcomes.runId, owner.runId));
        const previous: LastAttempt = { ...owner, outcome: ok ? "completed" : "interrupted",
          ...(outcome ? { recordStatus: outcome.status, reason: outcome.reason.slice(0, 2000) } : {}) };
        await trx.update(taskState).set({ value: { previous } }).where(where(leaseKey));
      });
    },
  };
}
