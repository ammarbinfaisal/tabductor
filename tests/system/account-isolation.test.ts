import { afterAll, beforeAll, expect, it } from "vitest";
import { accountMcpTokens } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createAccountMcpToken, resolveAccountIdentity, resolveAccountMcpToken } from "@tabductor/engine";
import { staticSchemaGenerator } from "@tabductor/engine/testing";
import { eq, sql } from "drizzle-orm";
import { appRouter, createCaller } from "../../apps/web/src/server/router.js";

let handle: MigratedTestDb;

beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });

const callerFor = (accountId: string) => createCaller({
  db: handle.db,
  pool: handle.pool,
  accountId,
  schemaGenerator: staticSchemaGenerator({}),
});

it("exposes no legacy action-grant or approval procedures", () => {
  expect(Object.keys(appRouter._def.procedures).some((name) => name.startsWith("policy."))).toBe(false);
});

it("rejects retired graph authoring APIs", () => {
  expect(appRouter._def.procedures).not.toHaveProperty("workflow.publishVersion");
  expect(appRouter._def.procedures).not.toHaveProperty("task.update");
});

it("isolates workflow reads and lists between resolved Clerk accounts", async () => {
  const a = await resolveAccountIdentity(handle.db, { provider: "clerk", subject: "user_a" });
  const b = await resolveAccountIdentity(handle.db, { provider: "clerk", subject: "user_b" });
  const apiA = callerFor(a);
  const apiB = callerFor(b);

  const workflowId = await apiA.workflow.create({ name: "A private workflow" });
  expect((await apiA.workflow.list()).map((workflow) => workflow.id)).toContain(workflowId);
  expect((await apiB.workflow.list()).map((workflow) => workflow.id)).not.toContain(workflowId);
  await expect(apiB.workflow.get({ id: workflowId })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("stores only hashed MCP tokens and rejects them after revocation", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "clerk", subject: "mcp_user" });
  const issued = await createAccountMcpToken(handle.db, { accountId, label: "Agent" });
  const [stored] = await handle.db.select().from(accountMcpTokens).where(eq(accountMcpTokens.id, issued.id));
  expect(stored?.tokenSha256).not.toContain(issued.token);
  expect(await resolveAccountMcpToken(handle.db, issued.token)).toBe(accountId);

  await handle.db.update(accountMcpTokens).set({ revokedAt: sql`now()` }).where(eq(accountMcpTokens.id, issued.id));
  expect(await resolveAccountMcpToken(handle.db, issued.token)).toBeUndefined();
});
