import { createHash, randomBytes } from "node:crypto";
import { newId } from "@tabductor/core";
import {
  accountIdentities,
  accountMcpTokens,
  accounts,
  browserSessions,
  events,
  runs,
  tasks,
  workflowExecutions,
  workflowShares,
  workflowVersions,
  workflows,
  type Db,
} from "@tabductor/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Resolve one external identity to one stable personal account, safe under concurrent sign-in. */
export async function resolveAccountIdentity(
  db: Db,
  input: { provider: "clerk" | "fixture"; subject: string; name?: string },
): Promise<string> {
  const [existing] = await db.select({ accountId: accountIdentities.accountId })
    .from(accountIdentities)
    .where(and(eq(accountIdentities.provider, input.provider), eq(accountIdentities.subject, input.subject)));
  if (existing) return existing.accountId;

  const accountId = `acct_${digest(`${input.provider}:${input.subject}`).slice(0, 24)}`;
  await db.transaction(async (trx) => {
    await trx.insert(accounts).values({ id: accountId, name: input.name?.trim() || "Personal account" }).onConflictDoNothing();
    await trx.insert(accountIdentities).values({
      provider: input.provider,
      subject: input.subject,
      accountId,
    }).onConflictDoNothing();
  });
  const [resolved] = await db.select({ accountId: accountIdentities.accountId })
    .from(accountIdentities)
    .where(and(eq(accountIdentities.provider, input.provider), eq(accountIdentities.subject, input.subject)));
  if (!resolved) throw new Error("account identity could not be resolved");
  return resolved.accountId;
}

export async function createAccountMcpToken(
  db: Db,
  input: { accountId: string; label?: string },
): Promise<{ id: string; token: string; prefix: string }> {
  const token = `td_mcp_${randomBytes(32).toString("base64url")}`;
  const prefix = token.slice(0, 15);
  const id = newId("mcptok");
  await db.insert(accountMcpTokens).values({
    id,
    accountId: input.accountId,
    tokenSha256: digest(token),
    tokenPrefix: prefix,
    label: input.label?.trim() || "MCP token",
  });
  return { id, token, prefix };
}

export async function resolveAccountMcpToken(db: Db, token: string): Promise<string | undefined> {
  const [row] = await db.update(accountMcpTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(accountMcpTokens.tokenSha256, digest(token)), isNull(accountMcpTokens.revokedAt)))
    .returning({ accountId: accountMcpTokens.accountId });
  return row?.accountId;
}

export async function accountOwnsWorkflow(db: Db, accountId: string, workflowId: string): Promise<boolean> {
  const [row] = await db.select({ id: workflows.id }).from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.accountId, accountId)));
  return Boolean(row);
}

export async function accountOwnsTask(db: Db, accountId: string, taskId: string): Promise<boolean> {
  const [row] = await db.select({ id: tasks.id }).from(tasks)
    .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(and(eq(tasks.id, taskId), eq(workflows.accountId, accountId)));
  return Boolean(row);
}

export async function accountOwnsRun(db: Db, accountId: string, runId: string): Promise<boolean> {
  const [row] = await db.select({ id: runs.id }).from(runs)
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(and(eq(runs.id, runId), eq(workflows.accountId, accountId)));
  return Boolean(row);
}

export async function accountOwnsEvent(db: Db, accountId: string, eventId: string): Promise<boolean> {
  const [row] = await db.select({ id: events.eventId }).from(events)
    .innerJoin(workflowExecutions, eq(workflowExecutions.id, events.executionId))
    .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .where(and(eq(events.eventId, eventId), eq(workflows.accountId, accountId)));
  return Boolean(row);
}

export async function accountOwnsShare(db: Db, accountId: string, shareId: string): Promise<boolean> {
  const [row] = await db.select({ id: workflowShares.id }).from(workflowShares)
    .innerJoin(workflows, eq(workflows.id, workflowShares.workflowId))
    .where(and(eq(workflowShares.id, shareId), eq(workflows.accountId, accountId)));
  return Boolean(row);
}

export async function accountOwnsBrowserSession(db: Db, accountId: string, sessionId: string): Promise<boolean> {
  const [row] = await db.select({ id: browserSessions.id }).from(browserSessions)
    .where(and(eq(browserSessions.id, sessionId), eq(browserSessions.accountId, accountId)));
  return Boolean(row);
}
