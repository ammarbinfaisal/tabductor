import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { browserChallenges, challengeAttempts } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { advanceChallengeRecovery, appendCreditAdjustment, claimBrowserAllocation, createBrowserProfile, endBrowserSession, fulfillBrowserAllocation,
  getCreditBalance, requestBrowserSession, requestBrowserTakeover, requestChallengeRecovery, resolveAccountIdentity, type SolverProvider } from "@tabductor/engine";
import { eq, sql } from "drizzle-orm";
let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });
async function fixture(name: string, kind = "recaptcha_v2", credits = 100) {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: name });
  if (credits) await appendCreditAdjustment(handle.db, { accountId, kind: "purchase", units: credits, idempotencyKey: name });
  const profileId = await createBrowserProfile(handle.db, { accountId, name });
  const sessionId = await requestBrowserSession(handle.db, { accountId, profileId });
  const allocation = await claimBrowserAllocation(handle.db, { maxAllocated: 20 });
  await fulfillBrowserAllocation(handle.db, { ...allocation!, workerId: `worker_${name}`, podName: `pod-${name}` });
  const id = await requestChallengeRecovery(handle.db, { accountId, sessionId, kind, websiteUrl: "https://fixture.example/login?secret=hidden", siteKey: "public-site-key" });
  return { id, accountId, sessionId };
}
const advanceClock = (id: string) => handle.db.update(browserChallenges).set({ nextPollAt: sql`now() - interval '1 second'` }).where(eq(browserChallenges.id, id));
const provider = (name = "fixture"): SolverProvider => ({ name, rateVersion: "fixture-v1", creditUnits: 5, supports: ["recaptcha_v2"],
  submit: vi.fn(async () => ({ taskId: "123" })), poll: vi.fn(async () => ({ status: "ready" as const, token: "never-persist-solution" })) });
it("deduplicates paid submissions and bills provider success independently from page verification", async () => {
  const { id, accountId } = await fixture("challenge-success");
  const p = provider(), apply = vi.fn(async () => true);
  await Promise.all(Array.from({ length: 5 }, () => advanceChallengeRecovery(handle.db, id, [p], apply)));
  expect(p.submit).toHaveBeenCalledTimes(1);
  expect((await getCreditBalance(handle.db, accountId)).reservedUnits).toBe(5);
  await advanceClock(id);
  expect(await advanceChallengeRecovery(handle.db, id, [p], apply)).toBe("solved");
  expect(await advanceChallengeRecovery(handle.db, id, [p], apply)).toBe("solved");
  expect(apply).toHaveBeenCalledTimes(1);
  expect((await getCreditBalance(handle.db, accountId)).availableUnits).toBe(95);
  expect(JSON.stringify(await handle.db.select().from(challengeAttempts))).not.toContain("never-persist-solution");
  expect(JSON.stringify(await handle.db.select().from(browserChallenges))).not.toContain("secret=hidden");
});
it("stops at three invalid solutions and requests a human", async () => {
  const { id } = await fixture("challenge-invalid");
  const p = provider();
  for (let n = 0; n < 3; n++) {
    await advanceClock(id); await advanceChallengeRecovery(handle.db, id, [p], async () => false);
    await advanceClock(id); await advanceChallengeRecovery(handle.db, id, [p], async () => false);
  }
  await advanceClock(id);
  expect(await advanceChallengeRecovery(handle.db, id, [p], async () => false)).toBe("human_required");
  expect(p.submit).toHaveBeenCalledTimes(3);
});
it("never falls back after an ambiguous submission, and retains the hold", async () => {
  const { id, accountId } = await fixture("challenge-unknown");
  const p = provider(), fallback = provider("fallback");
  p.submit = vi.fn(async () => { throw new Error("network lost"); });
  expect(await advanceChallengeRecovery(handle.db, id, [p, fallback], async () => true)).toBe("human_required");
  await advanceClock(id);
  await advanceChallengeRecovery(handle.db, id, [p, fallback], async () => true);
  expect(fallback.submit).not.toHaveBeenCalled();
  expect((await getCreditBalance(handle.db, accountId)).reservedUnits).toBe(5);
});
it("falls back after a definitive rejection and charges only the accepted provider", async () => {
  const { id, accountId } = await fixture("challenge-fallback");
  const rejected = provider("rejected"), accepted = provider("accepted");
  rejected.submit = vi.fn(async () => ({ rejected: true as const }));
  await advanceChallengeRecovery(handle.db, id, [rejected, accepted], async () => true);
  expect((await getCreditBalance(handle.db, accountId)).reservedUnits).toBe(0);
  await advanceClock(id);
  await advanceChallengeRecovery(handle.db, id, [rejected, accepted], async () => true);
  await advanceClock(id);
  expect(await advanceChallengeRecovery(handle.db, id, [rejected, accepted], async () => true)).toBe("solved");
  expect(rejected.submit).toHaveBeenCalledTimes(1);
  expect(accepted.submit).toHaveBeenCalledTimes(1);
  expect((await getCreditBalance(handle.db, accountId)).availableUnits).toBe(95);
});
it("does not purchase solutions after takeover or apply a result arriving after its deadline", async () => {
  const paused = await fixture("challenge-paused"), late = await fixture("challenge-late");
  const p = provider(), apply = vi.fn(async () => true);
  await requestBrowserTakeover(handle.db, { accountId: paused.accountId, sessionId: paused.sessionId });
  expect(await advanceChallengeRecovery(handle.db, paused.id, [p], apply)).toBe("human_required");
  expect(p.submit).not.toHaveBeenCalled();
  await advanceChallengeRecovery(handle.db, late.id, [p], apply);
  await advanceClock(late.id);
  // The provider returns after the deadline captured by the claimed operation.
  await handle.db.update(browserChallenges).set({ deadline: new Date(Date.now() + 100) }).where(eq(browserChallenges.id, late.id));
  p.poll = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { status: "ready" as const, token: "late-token" };
  });
  expect(await advanceChallengeRecovery(handle.db, late.id, [p], apply)).toBe("human_required");
  expect(apply).not.toHaveBeenCalled();
  expect((await getCreditBalance(handle.db, late.accountId)).availableUnits).toBe(95);
});
it("unsupported challenges, exhausted deadlines, and insufficient credits make no paid requests", async () => {
  const unsupported = await fixture("challenge-mfa", "mfa");
  const poor = await fixture("challenge-poor", "recaptcha_v2", 0);
  const expired = await fixture("challenge-expired");
  const p = provider();
  expect(await advanceChallengeRecovery(handle.db, unsupported.id, [p], async () => true)).toBe("human_required");
  await expect(advanceChallengeRecovery(handle.db, poor.id, [p], async () => true)).rejects.toMatchObject({ code: "credit_insufficient" });
  await handle.db.update(browserChallenges).set({ deadline: new Date(0) }).where(eq(browserChallenges.id, expired.id));
  expect(await advanceChallengeRecovery(handle.db, expired.id, [p], async () => true)).toBe("human_required");
  expect(p.submit).not.toHaveBeenCalled();
  for (const entry of [unsupported, poor, expired]) await endBrowserSession(handle.db, entry.sessionId);
});
