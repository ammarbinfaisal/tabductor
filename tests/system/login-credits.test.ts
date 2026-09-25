import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { creditLedgerEntries, billingSettings } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { getCreditBalance } from "@tabductor/engine";

const authState = vi.hoisted(() => ({ configured: true, session: { userId: "login-user", sessionId: "login-one" } as {userId: string | null; sessionId: string | null} }));
vi.mock("../../apps/web/node_modules/@clerk/nextjs/dist/cjs/server/index.js", () => ({ auth: async () => authState.session }));
vi.mock("../../apps/web/node_modules/@clerk/nextjs/dist/esm/server/index.js", () => ({ auth: async () => authState.session }));
vi.mock("../../apps/web/src/server/clerk-config.js", () => ({ clerkConfigured: () => authState.configured }));
vi.mock("../../apps/web/src/server/db.js", () => ({ db: () => database.db }));
import { accountIdForWebRequest } from "../../apps/web/src/server/auth-context.js";
let database: MigratedTestDb;
beforeAll(async () => { database = await createMigratedTestDb(); await database.db.insert(billingSettings).values({key:"welcome",value:{amountUsd:"0.001"},updatedAt:new Date(0)}); });
afterAll(async () => { await database?.close(); vi.unstubAllEnvs(); });

it("grants a welcome balance once per account under concurrent requests and keeps accounts isolated", async () => {
  const accounts = await Promise.all(Array.from({length: 8}, () => accountIdForWebRequest()));
  const accountId = accounts[0]!;
  expect(new Set(accounts).size).toBe(1);
  expect((await getCreditBalance(database.db, accountId)).availableUnits).toBe(1000);
  await accountIdForWebRequest();
  expect((await getCreditBalance(database.db, accountId)).availableUnits).toBe(1000);
  authState.session.sessionId = "login-two";
  await accountIdForWebRequest();
  expect((await getCreditBalance(database.db, accountId)).availableUnits).toBe(1000);
  authState.session = {userId: "another-user", sessionId: "another-login"};
  const otherAccount = await accountIdForWebRequest();
  expect((await getCreditBalance(database.db, otherAccount)).availableUnits).toBe(1000);
  const grants = await database.db.select().from(creditLedgerEntries).where(eq(creditLedgerEntries.accountId, accountId));
  expect(grants).toHaveLength(1);
  expect(grants.every(g => g.kind === "adjustment" && g.units === 1000)).toBe(true);
  expect(JSON.stringify(grants)).not.toContain("login-one");
});

it("does not grant credits for unauthenticated requests", async () => {
  authState.session = {userId: null, sessionId: null};
  await expect(accountIdForWebRequest()).rejects.toMatchObject({code: "UNAUTHORIZED"});
  authState.session = {userId: "login-user", sessionId: null};
  await expect(accountIdForWebRequest()).rejects.toMatchObject({code: "UNAUTHORIZED"});
});

it("grants once per local account across restarts and preserves the production auth guard", async () => {
  authState.configured = false;
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("TABDUCTOR_FIXTURE_MODE", "0");
  await expect(accountIdForWebRequest()).rejects.toMatchObject({code: "UNAUTHORIZED"});
  vi.stubEnv("TABDUCTOR_FIXTURE_MODE", "1");
  const startup = globalThis as { __tabductorCreditStartupId?: string };
  startup.__tabductorCreditStartupId = "test-startup-one";
  await Promise.all([accountIdForWebRequest(), accountIdForWebRequest()]);
  expect((await getCreditBalance(database.db, "acct_local")).availableUnits).toBe(1000);
  startup.__tabductorCreditStartupId = "test-startup-two";
  await accountIdForWebRequest();
  expect((await getCreditBalance(database.db, "acct_local")).availableUnits).toBe(1000);
  delete startup.__tabductorCreditStartupId;
});
