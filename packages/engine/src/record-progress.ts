import { AppError } from "@tabductor/core";
import { runRecordOutcomes, workflowRecords, type Db, type EventRow, type RunRow, type TaskRow, type RecordStatus } from "@tabductor/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertRunLease } from "./run-lease.js";

export type RecordOutcome = { collection?: string; recordKey?: string; status: RecordStatus; reason: string;
  verification?: { snapshotId?: string; assessmentId?: string; method?: "readback" | "ai-assessment";
    url: string; recordKey?: string; checkedAt: string; destinationContractId?: string; committed?: boolean } };

/** Events are outputs, never implicit record state transitions. */
export async function recordEmitted(_db: Db, _run: RunRow, _task: TaskRow, _event: EventRow): Promise<void> {}

export async function recordRunOutcome(db: Db, run: RunRow, _task: TaskRow, _trigger: EventRow | null, outcome: RecordOutcome): Promise<void> {
  const { collection, recordKey } = outcome;
  if (!run.executionId || !collection?.trim() || collection.length > 200 || !recordKey?.trim() || recordKey.length > 2000) {
    throw new AppError("record_identity_required", "Provide an explicit collection and stable recordKey");
  }
  if (outcome.verification && outcome.verification.recordKey !== recordKey) throw new AppError("record_verification_mismatch", "Verification must belong to this recordKey");
  await db.transaction(async trx => {
    await assertRunLease(trx, run.id, run.leaseGeneration);
    const value = { status: outcome.status, reason: outcome.reason.slice(0, 1000), verificationJson: outcome.verification ?? null };
    await trx.insert(runRecordOutcomes).values({ runId: run.id, collection, recordKey, ...value })
      .onConflictDoUpdate({ target: [runRecordOutcomes.runId, runRecordOutcomes.collection, runRecordOutcomes.recordKey], set: value,
        setWhere: sql`${runRecordOutcomes.status} <> 'saved'` });
    await trx.insert(workflowRecords).values({ executionId: run.executionId!, collection, recordKey, lastRunId: run.id, ...value })
      .onConflictDoUpdate({ target: [workflowRecords.executionId, workflowRecords.collection, workflowRecords.recordKey],
        set: { ...value, lastRunId: run.id, updatedAt: new Date() },
        setWhere: outcome.status === "extracted" ? sql`false` : sql`${workflowRecords.status} <> 'saved'` });
  });
}

export async function recordCompletionError(db: Db, run: RunRow, _task: TaskRow): Promise<string | null> {
  if (!run.executionId) return null;
  const [pending] = await db.select({ key: workflowRecords.recordKey }).from(workflowRecords)
    .where(and(eq(workflowRecords.executionId, run.executionId), inArray(workflowRecords.status, ["extracted", "prepared", "pending", "failed"]))).limit(1);
  return pending ? `record_outcome_missing: finish or explicitly skip, reject, or fail record ${pending.key}` : null;
}

export async function recordFailedRun(db: Db, run: RunRow): Promise<void> {
  if (!run.executionId) return;
  await db.update(workflowRecords).set({ status: "failed", reason: (run.error ?? run.status).slice(0,1000), updatedAt: new Date() })
    .where(and(eq(workflowRecords.executionId, run.executionId), eq(workflowRecords.lastRunId, run.id), inArray(workflowRecords.status, ["extracted", "prepared", "pending"])));
}

export async function recordProgress(db: Db, executionId: string) {
  const rows = await db.select({ status: workflowRecords.status, count: sql<number>`count(*)::int`,
    verified:sql<number>`count(*) filter (where ${workflowRecords.verificationJson}->>'method' = 'readback' or (${workflowRecords.verificationJson}->>'snapshotId' is not null and ${workflowRecords.verificationJson}->>'method' is null))::int`,
    aiAssessed:sql<number>`count(*) filter (where ${workflowRecords.verificationJson}->>'method' = 'ai-assessment')::int` }).from(workflowRecords)
    .where(eq(workflowRecords.executionId, executionId)).groupBy(workflowRecords.status);
  const counts: Record<RecordStatus, number> = { extracted: 0, prepared: 0, pending: 0, saved: 0, skipped: 0, rejected: 0, failed: 0 };
  for (const row of rows) counts[row.status] = row.count;

  const aiAssessedSaved = rows.find(row=>row.status === "saved")?.aiAssessed ?? 0;
  const verifiedSaved = rows.find(row=>row.status === "saved")?.verified ?? 0;
  return { tracked: rows.length > 0, total: rows.reduce((n, row) => n + row.count, 0), ...counts,
    verifiedSaved,aiAssessedSaved,reportedSaved:counts.saved-verifiedSaved-aiAssessedSaved };
}
