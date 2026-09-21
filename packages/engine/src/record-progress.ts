import { AppError } from "@tabductor/core";
import { eventDefs, events, workflowExecutions, runRecordOutcomes, workflowRecords, type Db, type EventRow, type RunRow, type TaskRow, type RecordStatus } from "@tabductor/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { assertRunLease } from "./run-lease.js";
import { destinationCompletionError, saveDestinationRecord } from "./destination-contracts.js";

export type RecordOutcome = { status: "prepared" | "skipped" | "rejected" | "failed" | "saved"; reason: string;
  verification?: { snapshotId: string; url: string; recordKey?: string; checkedAt: string; destinationContractId?: string; committed?: boolean } };

async function definition(db: Db, task: TaskRow, type: string) {
  const [row] = await db.select().from(eventDefs).where(and(eq(eventDefs.workflowVersionId, task.workflowVersionId), eq(eventDefs.eventType, type)));
  return row?.recordJson;
}
function keyOf(packet: unknown, field: string): string {
  const value = packet && typeof packet === "object" ? (packet as Record<string, unknown>)[field] : undefined;
  if (!(typeof value === "string" && value.length > 0 || typeof value === "number" && Number.isSafeInteger(value)) || String(value).length > 2000) {
    throw new AppError("record_key_missing", `Record requires a stable ${field}`);
  }
  return String(value);
}

/** Runs inside the event publication transaction; duplicate delivery never counts twice. */
export async function recordEmitted(db: Db, run: RunRow, task: TaskRow, event: EventRow): Promise<void> {
  if (!run.executionId) return;
  const contract = await definition(db, task, event.type);
  if (!contract) return;
  const [outcome] = await db.select().from(runRecordOutcomes).where(eq(runRecordOutcomes.runId, run.id));
  if (contract.status === "saved" && (outcome?.status !== "saved" || !outcome.verificationJson)) {
    throw new AppError("record_verification_required", "Record a verified destination outcome before emitting a saved event");
  }
  const recordKey = keyOf(event.packet, contract.key);
  if (contract.status === "saved") {
    const [trigger] = run.triggerEventId ? await db.select().from(events).where(eq(events.eventId, run.triggerEventId)) : [];
    const input = trigger ? await definition(db, task, trigger.type) : null;
    if (!trigger || !input || input.collection !== contract.collection || keyOf(trigger.packet, input.key) !== recordKey) {
      throw new AppError("record_verification_mismatch", "Save evidence belongs to a different input record");
    }
  }
  const update = { status: contract.status, lastRunId: run.id, updatedAt: new Date(),
    ...(contract.status === "saved" ? { verificationJson: outcome!.verificationJson } : {}) };
  await db.insert(workflowRecords).values({ executionId: run.executionId, collection: contract.collection,
    recordKey, sourceEventId: event.eventId, ...update })
    .onConflictDoUpdate({ target: [workflowRecords.executionId, workflowRecords.collection, workflowRecords.recordKey], set: update,
      // Re-extraction and duplicate preparation must never erase terminal evidence.
      setWhere: contract.status === "extracted" ? sql`false` : inArray(workflowRecords.status, contract.status === "prepared" ? ["extracted", "failed"] : ["extracted", "prepared", "pending", "failed"]) });
}

export async function recordRunOutcome(db: Db, run: RunRow, task: TaskRow, trigger: EventRow | null, outcome: RecordOutcome): Promise<void> {
  if (!trigger || /^(?:manual\.|schedule\.|run\.|system\.)/.test(trigger.type)) throw new AppError("record_input_missing", "This run has no input record");
  if (outcome.status === "saved" && (task.kind !== "browser" || !outcome.verification?.snapshotId)) {
    throw new AppError("record_verification_required", "Saving a record requires fresh browser verification");
  }
  await db.transaction(async trx => {
    await assertRunLease(trx, run.id, run.leaseGeneration);
    if (outcome.status === "prepared") {
      const [emitted] = await trx.select({ id: events.eventId }).from(events).where(eq(events.sourceRunId, run.id)).limit(1);
      if (!emitted) throw new AppError("record_not_prepared", "Emit an acknowledged prepared result before recording preparation");
    }
    const contract = await definition(trx, task, trigger.type);
    if (outcome.status === "saved" && !contract) throw new AppError("record_contract_missing", "Publish a record identity contract before counting destination saves");
    if (outcome.status === "saved" && outcome.verification?.recordKey !== keyOf(trigger.packet, contract!.key)) {
      throw new AppError("record_verification_mismatch", "Verify the exact input recordKey at the destination before counting a save");
    }
    const value = { status: outcome.status, reason: outcome.reason.slice(0, 1000), verificationJson: outcome.verification ?? null };
    if (outcome.status === "saved") await saveDestinationRecord(trx, run, task, trigger, outcome.verification!);
    await trx.insert(runRecordOutcomes).values({ runId: run.id, ...value })
      .onConflictDoUpdate({ target: runRecordOutcomes.runId, set: value,
        setWhere: sql`${runRecordOutcomes.status} <> 'saved'` });
    if (contract && run.executionId) {
      await trx.update(workflowRecords).set({ ...value, lastRunId: run.id, updatedAt: new Date() })
        .where(and(eq(workflowRecords.executionId, run.executionId), eq(workflowRecords.collection, contract.collection),
          eq(workflowRecords.recordKey, keyOf(trigger.packet, contract.key)), outcome.status === "prepared" ? eq(workflowRecords.status, "extracted") : sql`${workflowRecords.status} <> 'saved'`));
    }
  });
}

/** Called while the run lease still belongs to its executor. Legacy packet decisions also
 * get the no-silent-success guard, even before they are republished with record metadata. */
export async function recordCompletionError(db: Db, run: RunRow, task: TaskRow): Promise<string | null> {
  const destinationError = await destinationCompletionError(db, run, task);
  if (destinationError) return destinationError;
  if (!run.triggerEventId || task.kind === "result" || task.mode === "stub") return null;
  const [trigger] = await db.select().from(events).where(eq(events.eventId, run.triggerEventId));
  if (!trigger || /^(?:manual\.|schedule\.|run\.|system\.)/.test(trigger.type)) return null;
  const contract = await definition(db, task, trigger.type);
  if (task.kind !== "decision" && !contract) return null;
  const [explicit] = await db.select().from(runRecordOutcomes).where(eq(runRecordOutcomes.runId, run.id));
  if (explicit) return explicit.status === "failed" ? `record_failed: ${explicit.reason}` : null;
  const [emitted] = await db.select({ id: events.eventId }).from(events).where(eq(events.sourceRunId, run.id)).limit(1);
  if (emitted && task.kind === "decision") {
    await recordRunOutcome(db, run, task, trigger, { status: "prepared", reason: "Prepared output acknowledged by the event bus" });
    return null;
  }
  return "record_outcome_missing: emit an acknowledged prepared result or record an explicit skipped, rejected, failed, or verified saved outcome";
}

/** Watchdog failures also count; a later retry may recover failed records. */
export async function recordFailedRun(db: Db, run: RunRow): Promise<void> {
  if (!run.executionId || !run.triggerEventId) return;
  const [trigger] = await db.select().from(events).where(eq(events.eventId, run.triggerEventId));
  if (!trigger) return;
  const [contract] = await db.select({ record: eventDefs.recordJson }).from(eventDefs)
    .where(and(eq(eventDefs.workflowVersionId, run.workflowVersionId!), eq(eventDefs.eventType, trigger.type)));
  await db.insert(runRecordOutcomes).values({ runId: run.id, status: "failed", reason: (run.error ?? run.status).slice(0, 1000) }).onConflictDoNothing();
  if (contract?.record) await db.update(workflowRecords).set({ status: "failed", lastRunId: run.id, reason: (run.error ?? run.status).slice(0, 1000), updatedAt: new Date() })
    .where(and(eq(workflowRecords.executionId, run.executionId), eq(workflowRecords.collection, contract.record.collection),
      eq(workflowRecords.recordKey, keyOf(trigger.packet, contract.record.key)), inArray(workflowRecords.status, ["extracted", "prepared", "pending"])));
}

export async function recordProgress(db: Db, executionId: string) {
  const rows = await db.select({ status: workflowRecords.status, count: sql<number>`count(*)::int` }).from(workflowRecords)
    .where(eq(workflowRecords.executionId, executionId)).groupBy(workflowRecords.status);
  const counts: Record<RecordStatus, number> = { extracted: 0, prepared: 0, pending: 0, saved: 0, skipped: 0, rejected: 0, failed: 0 };
  for (const row of rows) counts[row.status] = row.count;
  const [configured] = rows.length ? [{ configured: true }] : await db.select({ configured: eventDefs.id }).from(eventDefs)
    .innerJoin(workflowExecutions, eq(workflowExecutions.workflowVersionId, eventDefs.workflowVersionId))
    .where(and(eq(workflowExecutions.id, executionId), isNotNull(eventDefs.recordJson))).limit(1);
  return { tracked: Boolean(configured), total: rows.reduce((n, row) => n + row.count, 0), ...counts };
}
