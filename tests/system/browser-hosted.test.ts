import { afterAll, beforeAll, expect, it } from "vitest";
import { browserProfiles, browserSessions, workflows } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { appendCreditAdjustment, browserCreditAdmission, claimBrowserAllocation, createBrowserProfile, createWorkflow,
  endBrowserSession, ensureWorkflowBrowserProfile, expireCreditReservations, getCreditBalance, requestBrowserSession,
  resolveAccountIdentity, settleBrowserUsage, fulfillBrowserAllocation } from "@tabductor/engine";
import { eq, sql } from "drizzle-orm";
let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });
it("creates one account-owned profile under concurrent first runs", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "hosted-profile" });
  const workflowId = await createWorkflow(handle.db, { accountId, userId: "test", name: "Profile" });
  const ids = await Promise.all(Array.from({ length: 6 }, () => ensureWorkflowBrowserProfile(handle.db, accountId, workflowId)));
  expect(new Set(ids).size).toBe(1);
  expect(await handle.db.select().from(browserProfiles)).toHaveLength(1);
  await expect(ensureWorkflowBrowserProfile(handle.db, "acct_local", workflowId)).rejects.toMatchObject({ code: "workflow_not_found" });
  expect((await handle.db.select().from(workflows).where(eq(workflows.id, workflowId)))[0]?.accountId).toBe(accountId);
});
it("bills ready browser time once, reserves no queued time, and retains active holds for crash recovery", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "hosted-billing" });
  await appendCreditAdjustment(handle.db, { accountId, kind: "purchase", units: 100, idempotencyKey: "browser-topup" });
  const profileId = await createBrowserProfile(handle.db, { accountId, name: "Billing" });
  const sessionId = await requestBrowserSession(handle.db, { accountId, profileId });
  expect((await getCreditBalance(handle.db, accountId)).reservedUnits).toBe(0);
  const allocation = await claimBrowserAllocation(handle.db, { admission: browserCreditAdmission({ version: "test-v1", unitsPerMinute: 2, maxSeconds: 300 }) });
  expect((await getCreditBalance(handle.db, accountId)).reservedUnits).toBe(10);
  await expireCreditReservations(handle.db, new Date(Date.now() + 86400_000 * 2));
  expect((await getCreditBalance(handle.db, accountId)).reservedUnits).toBe(10);
  await fulfillBrowserAllocation(handle.db, { ...allocation!, workerId: "billing-worker", podName: "billing-worker" });
  await handle.db.update(browserSessions).set({ readyAt: sql`now() - interval '65 seconds'` }).where(eq(browserSessions.id, sessionId));
  await endBrowserSession(handle.db, sessionId);
  await Promise.all([settleBrowserUsage(handle.db, sessionId), settleBrowserUsage(handle.db, sessionId)]);
  expect(await getCreditBalance(handle.db, accountId)).toEqual({ availableUnits: 96, reservedUnits: 0, totalUnits: 96 });
  expect((await handle.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId)))[0]?.status).toBe("ended");
});
