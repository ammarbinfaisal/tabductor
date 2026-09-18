import { afterEach, beforeEach, expect, it } from "vitest";
import { browserSessions, browserProfileLeases, browserAllocationRequests, workflowExecutions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  claimBrowserAllocation,
  failBrowserAllocation,
  createWorkflow,
  createWorkflowExecution,
  publishVersion,
  staticSchemaGenerator,
  reserveCredits,
  appendCreditAdjustment,
  getCreditBalance,
  createBrowserProfile,
  fulfillBrowserAllocation,
  endBrowserSession,
  requestBrowserSession,
  resolveAccountIdentity,
} from "@tabductor/engine";
import { eq, sql } from "drizzle-orm";

let handle: MigratedTestDb;
beforeEach(async () => { handle = await createMigratedTestDb(); });
afterEach(async () => { await handle?.close(); });

it("holds an exclusive profile lease and generation-fences allocation", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "fleet_a" });
  const profileId = await createBrowserProfile(handle.db, { accountId, name: "Primary" });
  const sessionId = await requestBrowserSession(handle.db, { accountId, profileId });
  const waitingSessionId = await requestBrowserSession(handle.db, { accountId, profileId });

  const allocation = await claimBrowserAllocation(handle.db);
  expect(allocation).toMatchObject({ accountId, profileId, sessionId, generation: 1 });
  await fulfillBrowserAllocation(handle.db, { ...allocation!, workerId: "worker_1", podName: "browser-1" });
  const [session] = await handle.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
  expect(session).toMatchObject({ status: "ready", workerId: "worker_1", podName: "browser-1" });
  expect(await claimBrowserAllocation(handle.db)).toBeUndefined();
  await endBrowserSession(handle.db, sessionId);
  expect(await claimBrowserAllocation(handle.db)).toMatchObject({ sessionId: waitingSessionId });
});

it("takes one queue head per account before a second queued profile", async () => {
  const a = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "fair_a" });
  const b = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "fair_b" });
  const [a1, a2, b1] = await Promise.all([
    createBrowserProfile(handle.db, { accountId: a, name: "A1" }),
    createBrowserProfile(handle.db, { accountId: a, name: "A2" }),
    createBrowserProfile(handle.db, { accountId: b, name: "B1" }),
  ]);
  await requestBrowserSession(handle.db, { accountId: a, profileId: a1 });
  await requestBrowserSession(handle.db, { accountId: a, profileId: a2 });
  await requestBrowserSession(handle.db, { accountId: b, profileId: b1 });

  const first = await claimBrowserAllocation(handle.db);
  const second = await claimBrowserAllocation(handle.db);
  expect(new Set([first?.accountId, second?.accountId])).toEqual(new Set([a, b]));
});

it("rejects foreign and terminal execution bindings before queueing a session", async () => {
  const a = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "owner_a" });
  const b = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "owner_b" });
  const workflowId = await createWorkflow(handle.db, { name: "Owned", userId: "user", accountId: a });
  await publishVersion(handle.db, { workflowId, graph: { tasks: [], events: [] } }, { schemaGenerator: staticSchemaGenerator() });
  const executionId = await createWorkflowExecution(handle.db, { workflowId });
  const foreignProfile = await createBrowserProfile(handle.db, { accountId: b, name: "Foreign" });
  await expect(requestBrowserSession(handle.db, { accountId: b, profileId: foreignProfile, executionId }))
    .rejects.toMatchObject({ code: "browser_execution_not_found" });
  await handle.db.update(workflowExecutions).set({ status: "succeeded" }).where(eq(workflowExecutions.id, executionId));
  const ownProfile = await createBrowserProfile(handle.db, { accountId: a, name: "Own" });
  await expect(requestBrowserSession(handle.db, { accountId: a, profileId: ownProfile, executionId }))
    .rejects.toMatchObject({ code: "browser_execution_not_found" });
  expect(await handle.db.select().from(browserSessions)).toHaveLength(0);
});

it("atomically caps allocation across concurrent controllers and starts queued work after release", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "capacity" });
  for (let n = 0; n < 5; n++) {
    const profileId = await createBrowserProfile(handle.db, { accountId, name: `Profile ${n}` });
    await requestBrowserSession(handle.db, { accountId, profileId });
  }
  const results = await Promise.all(Array.from({ length: 8 }, () => claimBrowserAllocation(handle.db, { maxAllocated: 3 })));
  const allocated = results.filter((result) => result !== undefined);
  expect(allocated).toHaveLength(3);
  expect(new Set(allocated.map((allocation) => allocation.sessionId)).size).toBe(3);
  expect(await handle.db.select().from(browserProfileLeases)).toHaveLength(3);
  await endBrowserSession(handle.db, allocated[0]!.sessionId);
  expect(await claimBrowserAllocation(handle.db, { maxAllocated: 3 })).toBeDefined();
  expect(await claimBrowserAllocation(handle.db, { maxAllocated: 3 })).toBeUndefined();
});

it.each([true, false])("rejects stale failure callbacks (retry=%s) without changing a newer allocation", async (retry) => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "generations" });
  const profileId = await createBrowserProfile(handle.db, { accountId, name: "Profile" });
  const sessionId = await requestBrowserSession(handle.db, { accountId, profileId });
  const first = (await claimBrowserAllocation(handle.db))!;
  await failBrowserAllocation(handle.db, first, "retryable allocation error");
  await handle.db.update(browserAllocationRequests).set({ notBefore: sql`now()` });
  const second = (await claimBrowserAllocation(handle.db))!;
  expect(second.generation).toBe(2);
  await expect(failBrowserAllocation(handle.db, first, "late failure", retry)).rejects.toMatchObject({ code: "browser_allocation_stale" });
  expect((await handle.db.select().from(browserSessions))[0]).toMatchObject({ id: sessionId, status: "allocating", generation: 2 });
  expect((await handle.db.select().from(browserProfileLeases))[0]).toMatchObject({ sessionId, generation: 2 });
});

it("rolls credit admission back with allocation failure and never reserves queued work", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "admission" });
  await appendCreditAdjustment(handle.db, { accountId, kind: "purchase", units: 100, idempotencyKey: "test-purchase" });
  const profileId = await createBrowserProfile(handle.db, { accountId, name: "Profile" });
  const sessionId = await requestBrowserSession(handle.db, { accountId, profileId });
  expect((await getCreditBalance(handle.db, accountId)).reservedUnits).toBe(0);
  await expect(claimBrowserAllocation(handle.db, { admission: { reserve: async (input, trx) => {
    await reserveCredits(trx, { accountId: input.accountId, operationId: input.sessionId, category: "browser", units: 10 });
    throw new Error("injected admission failure");
  } } })).rejects.toThrow("injected admission failure");
  expect(await getCreditBalance(handle.db, accountId)).toMatchObject({ availableUnits: 100, reservedUnits: 0 });
  expect((await handle.db.select().from(browserSessions))[0]).toMatchObject({ id: sessionId, status: "queued" });
  expect(await handle.db.select().from(browserProfileLeases)).toHaveLength(0);
});
