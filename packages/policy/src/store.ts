import { publish } from "@tabductor/bus";
import { newId } from "@tabductor/core";
import {
  accountBaselineRules,
  approvals,
  assetWriteGrants,
  secretGrants,
  taskGrants,
  type ApprovalRow,
  type ApprovalStatus,
  type Db,
  type TaskGrantRow,
} from "@tabductor/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BaselineRule, GrantKey } from "./gate.js";

export type TaskGrantInput = {
  grantKey: GrantKey;
  grantValue: string;
  requiresApproval?: boolean;
};

export async function listTaskGrants(db: Db, taskId: string): Promise<TaskGrantRow[]> {
  return db.select().from(taskGrants).where(eq(taskGrants.taskId, taskId));
}

export async function grantTask(db: Db, taskId: string, input: TaskGrantInput): Promise<TaskGrantRow> {
  return db.transaction(async (trx) => {
    const [row] = await trx
      .insert(taskGrants)
      .values({ taskId, ...input, requiresApproval: input.requiresApproval ?? false })
      .onConflictDoUpdate({
        target: [taskGrants.taskId, taskGrants.grantKey, taskGrants.grantValue],
        set: { requiresApproval: input.requiresApproval ?? false },
      })
      .returning();
    if (input.grantKey === "secret.use") {
      await trx.insert(secretGrants).values({ taskId, secretName: input.grantValue }).onConflictDoNothing();
    }
    if (input.grantKey === "asset.write") {
      await trx.insert(assetWriteGrants).values({ taskId, pathGlob: input.grantValue }).onConflictDoNothing();
    }
    return row!;
  });
}

export async function revokeTaskGrant(
  db: Db,
  taskId: string,
  grantKey: GrantKey,
  grantValue: string,
): Promise<boolean> {
  return db.transaction(async (trx) => {
    const rows = await trx
      .delete(taskGrants)
      .where(
        and(
          eq(taskGrants.taskId, taskId),
          eq(taskGrants.grantKey, grantKey),
          eq(taskGrants.grantValue, grantValue),
        ),
      )
      .returning({ taskId: taskGrants.taskId });
    if (grantKey === "secret.use") {
      await trx
        .delete(secretGrants)
        .where(and(eq(secretGrants.taskId, taskId), eq(secretGrants.secretName, grantValue)));
    }
    if (grantKey === "asset.write") {
      await trx
        .delete(assetWriteGrants)
        .where(and(eq(assetWriteGrants.taskId, taskId), eq(assetWriteGrants.pathGlob, grantValue)));
    }
    return rows.length > 0;
  });
}

export async function listBaselineRules(
  db: Db,
  userId: string,
): Promise<Array<{ id: string; rule: BaselineRule; createdAt: Date }>> {
  const rows = await db
    .select()
    .from(accountBaselineRules)
    .where(eq(accountBaselineRules.userId, userId))
    .orderBy(asc(accountBaselineRules.createdAt));
  return rows.map((row) => ({ id: row.id, rule: row.ruleJson as BaselineRule, createdAt: row.createdAt }));
}

export async function addBaselineRule(db: Db, userId: string, rule: BaselineRule): Promise<string> {
  const id = newId("baseline");
  await db.insert(accountBaselineRules).values({ id, userId, ruleJson: rule });
  return id;
}

export async function removeBaselineRule(db: Db, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(accountBaselineRules)
    .where(and(eq(accountBaselineRules.id, id), eq(accountBaselineRules.userId, userId)))
    .returning({ id: accountBaselineRules.id });
  return rows.length > 0;
}

export async function listApprovals(
  db: Db,
  status: ApprovalStatus | undefined = "pending",
): Promise<ApprovalRow[]> {
  const query = db.select().from(approvals).orderBy(asc(approvals.createdAt));
  return status === undefined ? query : query.where(eq(approvals.status, status));
}

export type ApprovalDecision = "granted" | "denied";

export async function decideApproval(
  db: Db,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<{ outcome: "decided" | "missing" | "not_pending" | "expired"; approval?: ApprovalRow }> {
  return db.transaction(async (trx) => {
    const [current] = await trx.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
    if (!current) return { outcome: "missing" };
    if (current.status !== "pending") return { outcome: "not_pending", approval: current };

    const expired = current.expiresAt.getTime() <= Date.now();
    const status = expired ? "expired" : decision;
    const [approval] = await trx
      .update(approvals)
      .set({ status, decidedAt: sql`now()` })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning();
    if (!approval) return { outcome: "not_pending" };

    await publish(trx, {
      type: status === "granted" ? "approval.granted" : "approval.denied",
      sourceTaskId: approval.taskId,
      sourceRunId: approval.runId,
      packet: {
        approvalId: approval.id,
        runId: approval.runId,
        taskId: approval.taskId,
        ...(status === "expired" ? { reason: "expired" } : {}),
      },
    });
    return { outcome: expired ? "expired" : "decided", approval };
  });
}
