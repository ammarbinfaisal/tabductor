import { publish } from "@tabductor/bus";
import { newId, taskContentHash } from "@tabductor/core";
import {
  accountBaselineRules,
  approvals,
  compiledScripts,
  proposedGrants,
  secretGrants,
  storeWriteGrants,
  storeSchemas,
  taskGrants,
  tasks,
  workflowVersions,
  workflows,
  type ApprovalRow,
  type ApprovalStatus,
  type Db,
  type ProposedGrantRow,
  type TaskGrantRow,
} from "@tabductor/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  GRANT_KEYS,
  baselineRuleSchema,
  grantValueMatches,
  type BaselineRule,
  type GrantKey,
} from "./gate.js";

export type TaskGrantInput = {
  grantKey: GrantKey;
  grantValue: string;
  requiresApproval?: boolean;
};

const storedTablesSpecSchema = z.record(
  z.string(),
  z.object({
    primaryKey: z.array(z.string()),
    schema: z.object({ properties: z.record(z.string(), z.unknown()).optional() }).passthrough(),
  }),
);

async function refreshTaskContentHash(db: Db, taskId: string): Promise<void> {
  const [task] = await db
    .select({
      kind: tasks.kind,
      contentBasisHash: tasks.contentBasisHash,
      tablesSpecJson: storeSchemas.tablesSpecJson,
    })
    .from(tasks)
    .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
    .leftJoin(storeSchemas, eq(storeSchemas.id, workflowVersions.storeSchemaId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task) return;
  if (!task.contentBasisHash) {
    await db.update(tasks).set({ contentHash: null }).where(eq(tasks.id, taskId));
    return;
  }

  const grants = await db
    .select({
      grantKey: taskGrants.grantKey,
      grantValue: taskGrants.grantValue,
      requiresApproval: taskGrants.requiresApproval,
    })
    .from(taskGrants)
    .where(eq(taskGrants.taskId, taskId));
  const parsedStore = task.tablesSpecJson ? storedTablesSpecSchema.safeParse(task.tablesSpecJson) : null;
  const tables = parsedStore?.success
    ? Object.entries(parsedStore.data).map(([name, spec]) => ({
        name,
        columns: Object.keys(spec.schema.properties ?? {}).sort(),
        primaryKey: spec.primaryKey,
      }))
    : [];
  const touched = new Set(grants.filter((grant) => grant.grantKey === "store.write").map((grant) => grant.grantValue));
  const relevantStore = tables.filter((table) => task.kind === "decision" || touched.has(table.name));
  await db
    .update(tasks)
    .set({ contentHash: taskContentHash({ basisHash: task.contentBasisHash, grants, store: relevantStore }) })
    .where(eq(tasks.id, taskId));
}

export async function listTaskGrants(db: Db, taskId: string): Promise<TaskGrantRow[]> {
  return db.select().from(taskGrants).where(eq(taskGrants.taskId, taskId));
}

export async function grantTask(db: Db, taskId: string, input: TaskGrantInput): Promise<TaskGrantRow> {
  return db.transaction(async (trx) => {
    const requiresApproval = input.requiresApproval ?? false;
    const [existing] = await trx
      .select({ requiresApproval: taskGrants.requiresApproval })
      .from(taskGrants)
      .where(and(
        eq(taskGrants.taskId, taskId),
        eq(taskGrants.grantKey, input.grantKey),
        eq(taskGrants.grantValue, input.grantValue),
      ))
      .limit(1);
    const changed = !existing || existing.requiresApproval !== requiresApproval;
    const [row] = await trx
      .insert(taskGrants)
      .values({ taskId, ...input, requiresApproval })
      .onConflictDoUpdate({
        target: [taskGrants.taskId, taskGrants.grantKey, taskGrants.grantValue],
        set: { requiresApproval },
      })
      .returning();
    if (input.grantKey === "secret.use") {
      await trx.insert(secretGrants).values({ taskId, secretName: input.grantValue }).onConflictDoNothing();
    }
    if (input.grantKey === "store.write") {
      await trx.insert(storeWriteGrants).values({ taskId, tableName: input.grantValue }).onConflictDoNothing();
    }
    if (changed) await refreshTaskContentHash(trx, taskId);
    const invalidated = changed ? await trx
      .update(compiledScripts)
      .set({ status: "invalidated" })
      .where(and(eq(compiledScripts.taskId, taskId), eq(compiledScripts.status, "active")))
      .returning({ id: compiledScripts.id }) : [];
    if (invalidated.length > 0) {
      await trx.update(tasks).set({ mode: "ai" }).where(eq(tasks.id, taskId));
      await publish(trx, {
        type: "compile.invalidated",
        sourceTaskId: taskId,
        packet: { taskId, reason: "task grants changed" },
      });
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
    if (grantKey === "store.write") {
      await trx
        .delete(storeWriteGrants)
        .where(and(eq(storeWriteGrants.taskId, taskId), eq(storeWriteGrants.tableName, grantValue)));
    }
    if (rows.length > 0) {
      await refreshTaskContentHash(trx, taskId);
      const invalidated = await trx
        .update(compiledScripts)
        .set({ status: "invalidated" })
        .where(and(eq(compiledScripts.taskId, taskId), eq(compiledScripts.status, "active")))
        .returning({ id: compiledScripts.id });
      if (invalidated.length > 0) {
        await trx.update(tasks).set({ mode: "ai" }).where(eq(tasks.id, taskId));
        await publish(trx, {
          type: "compile.invalidated",
          sourceTaskId: taskId,
          packet: { taskId, reason: "task grants changed" },
        });
      }
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

export async function listProposedGrants(db: Db, workflowVersionId: string): Promise<ProposedGrantRow[]> {
  return db
    .select()
    .from(proposedGrants)
    .where(eq(proposedGrants.workflowVersionId, workflowVersionId))
    .orderBy(asc(proposedGrants.createdAt));
}

export type ProposedGrantDecision = "approved" | "rejected";
export type ProposedGrantDecisionResult =
  | { outcome: "missing" | "not_pending" }
  | { outcome: "approved" | "rejected" | "stripped_by_baseline"; proposal: ProposedGrantRow };

/**
 * Converts one inert compiler proposal into the runtime grant rows. Baseline denial wins;
 * baseline approval requirements are copied onto the resulting task grant. A capability
 * change invalidates an active browser script before the proposal becomes approved.
 */
export async function decideProposedGrant(
  db: Db,
  proposalId: string,
  decision: ProposedGrantDecision,
): Promise<ProposedGrantDecisionResult> {
  return db.transaction(async (trx) => {
    const [proposal] = await trx.select().from(proposedGrants).where(eq(proposedGrants.id, proposalId)).limit(1);
    if (!proposal) return { outcome: "missing" };
    if (proposal.status !== "pending") return { outcome: "not_pending" };

    if (decision === "rejected") {
      const [rejected] = await trx
        .update(proposedGrants)
        .set({ status: "rejected" })
        .where(and(eq(proposedGrants.id, proposalId), eq(proposedGrants.status, "pending")))
        .returning();
      return rejected ? { outcome: "rejected", proposal: rejected } : { outcome: "not_pending" };
    }

    const parsedKey = z.enum(GRANT_KEYS).safeParse(proposal.grantKey);
    if (!parsedKey.success) {
      const [stripped] = await trx
        .update(proposedGrants)
        .set({ status: "stripped_by_baseline" })
        .where(and(eq(proposedGrants.id, proposalId), eq(proposedGrants.status, "pending")))
        .returning();
      return stripped ? { outcome: "stripped_by_baseline", proposal: stripped } : { outcome: "not_pending" };
    }

    const [task] = await trx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.workflowVersionId, proposal.workflowVersionId), eq(tasks.name, proposal.taskRef)))
      .limit(1);
    if (!task) return { outcome: "missing" };

    const baselineRows = await trx
      .select({ ruleJson: accountBaselineRules.ruleJson })
      .from(workflowVersions)
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .innerJoin(accountBaselineRules, eq(accountBaselineRules.userId, workflows.userId))
      .where(eq(workflowVersions.id, proposal.workflowVersionId));
    const parsedRules = baselineRows.map(({ ruleJson }) => baselineRuleSchema.safeParse(ruleJson));
    const rules = parsedRules
      .filter((result): result is z.SafeParseSuccess<BaselineRule> => result.success)
      .map((result) => result.data);
    const unsafeBaseline = parsedRules.some((result) => !result.success);
    const denied = rules.some(
      (rule) =>
        rule.effect === "deny" &&
        rule.grantKey === parsedKey.data &&
        grantValueMatches(parsedKey.data, rule.value, proposal.grantValue),
    );
    if (unsafeBaseline || denied) {
      const [stripped] = await trx
        .update(proposedGrants)
        .set({ status: "stripped_by_baseline" })
        .where(and(eq(proposedGrants.id, proposalId), eq(proposedGrants.status, "pending")))
        .returning();
      return stripped ? { outcome: "stripped_by_baseline", proposal: stripped } : { outcome: "not_pending" };
    }

    const baselineApproval = rules.some(
      (rule) =>
        rule.effect === "require_approval" &&
        rule.grantKey === parsedKey.data &&
        grantValueMatches(parsedKey.data, rule.value, proposal.grantValue),
    );
    const requiresApproval = proposal.requiresApproval || baselineApproval;
    await trx
      .insert(taskGrants)
      .values({
        taskId: task.id,
        grantKey: parsedKey.data,
        grantValue: proposal.grantValue,
        requiresApproval,
      })
      .onConflictDoUpdate({
        target: [taskGrants.taskId, taskGrants.grantKey, taskGrants.grantValue],
        set: { requiresApproval },
      });
    if (parsedKey.data === "secret.use") {
      await trx.insert(secretGrants).values({ taskId: task.id, secretName: proposal.grantValue }).onConflictDoNothing();
    }
    if (parsedKey.data === "store.write") {
      await trx.insert(storeWriteGrants).values({ taskId: task.id, tableName: proposal.grantValue }).onConflictDoNothing();
    }
    await refreshTaskContentHash(trx, task.id);

    const invalidated = await trx
      .update(compiledScripts)
      .set({ status: "invalidated" })
      .where(and(eq(compiledScripts.taskId, task.id), eq(compiledScripts.status, "active")))
      .returning({ id: compiledScripts.id });
    if (invalidated.length > 0) {
      await trx.update(tasks).set({ mode: "ai" }).where(eq(tasks.id, task.id));
      await publish(trx, {
        type: "compile.invalidated",
        sourceTaskId: task.id,
        packet: { taskId: task.id, reason: "approved grants changed" },
      });
    }

    const [approved] = await trx
      .update(proposedGrants)
      .set({ status: "approved", requiresApproval })
      .where(and(eq(proposedGrants.id, proposalId), eq(proposedGrants.status, "pending")))
      .returning();
    return approved ? { outcome: "approved", proposal: approved } : { outcome: "not_pending" };
  });
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
