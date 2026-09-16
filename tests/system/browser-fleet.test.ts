import { afterAll, beforeAll, expect, it } from "vitest";
import { browserSessions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  claimBrowserAllocation,
  createBrowserProfile,
  fulfillBrowserAllocation,
  requestBrowserSession,
  resolveAccountIdentity,
} from "@tabductor/engine";
import { eq } from "drizzle-orm";

let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });

it("holds an exclusive profile lease and generation-fences allocation", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "fleet_a" });
  const profileId = await createBrowserProfile(handle.db, { accountId, name: "Primary" });
  const sessionId = await requestBrowserSession(handle.db, { accountId, profileId });
  await expect(requestBrowserSession(handle.db, { accountId, profileId })).rejects.toMatchObject({ code: "browser_profile_busy" });

  const allocation = await claimBrowserAllocation(handle.db);
  expect(allocation).toMatchObject({ accountId, profileId, sessionId, generation: 1 });
  await fulfillBrowserAllocation(handle.db, { ...allocation!, workerId: "worker_1", podName: "browser-1" });
  const [session] = await handle.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
  expect(session).toMatchObject({ status: "ready", workerId: "worker_1", podName: "browser-1" });
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
