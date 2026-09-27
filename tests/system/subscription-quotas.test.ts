import { afterAll, beforeAll, expect, it } from "vitest";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { sql } from "drizzle-orm";
import { getEntitlement, resolveAccountIdentity, meterAllowance, appendCreditAdjustment, getCreditBalance, browserAllowanceAvailable, assertCaptchaIncluded } from "@tabductor/engine";
let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });
it("assigns Free idempotently and isolates concurrent allowance consumption", async () => {
  const accountId = await resolveAccountIdentity(handle.db,{ provider: "fixture", subject: "quotas" });
  const [a,b] = await Promise.all([getEntitlement(handle.db, accountId),getEntitlement(handle.db, accountId)]);
  expect(a.period.id).toBe(b.period.id);
  expect(a.plan.slug).toBe("free");
  await Promise.all(Array.from({length:10},(_,i)=>meterAllowance(handle.db,accountId,"browser",1080000,String(i))));
  expect(Number((await getEntitlement(handle.db, accountId)).period.browser_ms)).toBe(10800000);
  expect(await handle.db.transaction(trx => browserAllowanceAvailable(trx,accountId))).toBe(false);
  await expect(handle.db.transaction(trx => assertCaptchaIncluded(trx, accountId))).rejects.toMatchObject({code:"captcha_plan_disabled"});
});
it("paid overage consumes the wallet and stops further chargeable usage", async () => {
  const accountId = await resolveAccountIdentity(handle.db,{ provider: "fixture", subject: "paid-quotas" });
  await getEntitlement(handle.db, accountId);
  await handle.db.execute(sql`update account_subscriptions set plan_revision_id='developer_v1' where account_id=${accountId}`);
  await appendCreditAdjustment(handle.db,{accountId,kind:"purchase",units:1000,idempotencyKey:"paid-funding"});
  expect(await meterAllowance(handle.db,accountId,"browser",72000000,"included")).toBe(true);
  expect(await meterAllowance(handle.db,accountId,"browser",30000,"overage")).toBe(false);
  expect((await getCreditBalance(handle.db,accountId)).availableUnits).toBe(0);
  expect((await handle.db.transaction(trx => assertCaptchaIncluded(trx,accountId))).captcha).toBe(true);
});
