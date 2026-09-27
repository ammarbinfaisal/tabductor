import { AppError, newId } from "@tabductor/core";
import { type Db } from "@tabductor/db";
import { sql } from "drizzle-orm";
import { appendCreditAdjustmentLocked, getCreditBalance, lockCreditAccount } from "./credits.js";

export type PlanRevision = {
  id: string; slug: string; revision: number; name: string; monthly_micros: string;
  concurrent_browsers: number; browser_ms: string; workflow_runs: number; proxy_bytes: string;
  captcha: boolean; browser_hour_micros: string | null; proxy_gb_micros: string | null;
  paddle_price_id: string | null; public: boolean; enabled: boolean;
};
export type Subscription = {
  account_id: string; plan_revision_id: string; paddle_subscription_id: string | null; status: string;
  anchor_at: Date; period_start: Date; period_end: Date; pending_revision_id: string | null;
  cancel_at_end: boolean; provider_updated_at: Date | null;
};
export type AllowancePeriod = { id: string; starts_at: Date; ends_at: Date; runs: number; browser_ms: string; proxy_bytes: string; browser_charged: string; proxy_charged: string };

/** UTC anniversaries clamp short months without drifting the original signup day. */
export function monthlyPeriod(anchor: Date, now: Date): { start: Date; end: Date } {
  anchor = new Date(anchor); now = new Date(now);
  const atMonth = (offset: number) => {
    const d = new Date(anchor);
    d.setUTCDate(1); d.setUTCMonth(anchor.getUTCMonth() + offset);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(anchor.getUTCDate(), last));
    return d;
  };
  let offset = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
  if (atMonth(offset) > now) offset--;
  return { start: atMonth(offset), end: atMonth(offset + 1) };
}

export async function listPlans(db: Db, publicOnly = true): Promise<PlanRevision[]> {
  return (await db.execute<PlanRevision>(sql`select distinct on (slug) * from plan_revisions
    where enabled ${publicOnly ? sql`and public` : sql``} order by slug,revision desc`)).rows;
}

/** Call within a transaction: all quota and monetary mutations use the same account lock. */
export async function entitlementLocked(db: Db, accountId: string, now = new Date()) {
  await lockCreditAccount(db, accountId);
  let subscription = (await db.execute<Subscription>(sql`select * from account_subscriptions where account_id=${accountId} for update`)).rows[0];
  if (!subscription) {
    const account = (await db.execute<{ created_at: Date }>(sql`select created_at from accounts where id=${accountId}`)).rows[0];
    if (!account) throw new AppError("account_not_found", "Account not found");
    const dates = monthlyPeriod(account.created_at, now);
    const free = (await listPlans(db)).find(p => p.slug === "free")!;
    subscription = (await db.execute<Subscription>(sql`insert into account_subscriptions(account_id,plan_revision_id,anchor_at,period_start,period_end)
      values(${accountId},${free.id},${account.created_at},${dates.start},${dates.end}) returning *`)).rows[0]!;
    await db.execute(sql`insert into entitlement_history(id,account_id,plan_revision_id,starts_at,reason) values(${newId("ent")},${accountId},${free.id},${now},'signup')`);
  }
  subscription.anchor_at = new Date(subscription.anchor_at);
  subscription.period_start = new Date(subscription.period_start);
  subscription.period_end = new Date(subscription.period_end);
  let plan = (await db.execute<PlanRevision>(sql`select * from plan_revisions where id=${subscription.plan_revision_id}`)).rows[0]!;
  if (now >= subscription.period_end) {
    if (subscription.paddle_subscription_id && !["canceled", "cancelled"].includes(subscription.status)) {
      throw new AppError("subscription_renewal_pending", "Waiting for verified subscription renewal");
    }
    const dates = monthlyPeriod(subscription.anchor_at, now);
    if (plan.slug !== "free") {
      plan = (await listPlans(db)).find(p => p.slug === "free")!;
      await transitionEntitlement(db, accountId, plan.id, now, "cancellation");
    }
    subscription = (await db.execute<Subscription>(sql`update account_subscriptions set plan_revision_id=${plan.id},
      period_start=${dates.start},period_end=${dates.end},paddle_subscription_id=null,status='active',cancel_at_end=false,pending_revision_id=null
      where account_id=${accountId} returning *`)).rows[0]!;
  }
  await db.execute(sql`insert into subscription_periods(id,account_id,starts_at,ends_at)
    values(${newId("period")},${accountId},${subscription.period_start},${subscription.period_end}) on conflict(account_id,starts_at) do nothing`);
  const period = (await db.execute<AllowancePeriod>(sql`select * from subscription_periods where account_id=${accountId} and starts_at=${subscription.period_start} for update`)).rows[0]!;
  period.starts_at = new Date(period.starts_at); period.ends_at = new Date(period.ends_at);
  return { subscription, plan, period };
}
export async function getEntitlement(db: Db, accountId: string, now = new Date()) {
  return db.transaction(trx => entitlementLocked(trx, accountId, now));
}
export async function transitionEntitlement(db: Db, accountId: string, revisionId: string, at: Date, reason: string) {
  await db.execute(sql`update entitlement_history set ends_at=${at} where account_id=${accountId} and ends_at is null`);
  await db.execute(sql`insert into entitlement_history(id,account_id,plan_revision_id,starts_at,reason)
    values(${newId("ent")},${accountId},${revisionId},${at},${reason})`);
}
export async function admitMonthlyExecution(db: Db, accountId: string, executionId: string) {
  const { plan, period } = await entitlementLocked(db, accountId);
  const prior = await db.execute(sql`select 1 from execution_admissions where execution_id=${executionId}`);
  if (prior.rows.length) return;
  if (period.runs >= plan.workflow_runs) throw new AppError("monthly_run_limit", "Monthly workflow run allowance exhausted; upgrade or wait for renewal");
  await db.execute(sql`insert into execution_admissions values(${executionId},${period.id},${plan.id})`);
  await db.execute(sql`update subscription_periods set runs=runs+1 where id=${period.id}`);
}
export async function assertCaptchaIncluded(db: Db, accountId: string) {
  const { plan } = await entitlementLocked(db, accountId);
  if (!plan.captcha) throw new AppError("captcha_plan_disabled", "CAPTCHA solving requires a paid plan");
  return plan;
}

export function overageMicros(quantity: number, included: number, rate: number | null, divisor: number): number {
  if (![quantity,included,divisor].every(Number.isSafeInteger) || quantity < 0 || included < 0 || divisor <= 0 || (rate !== null && (!Number.isSafeInteger(rate) || rate < 0))) throw new Error("Invalid metering quantity");
  if (rate === null) return 0;
  const value = Number((BigInt(Math.max(0, quantity - included)) * BigInt(rate) + BigInt(divisor) - 1n) / BigInt(divisor));
  if (!Number.isSafeInteger(value)) throw new Error("Metering overflow");
  return value;
}

/** Provider cumulative traffic revisions are replaceable; wallet effects are transactional deltas. */
export async function meterAllowance(db: Db, accountId: string, category: "browser" | "proxy", quantity: number, sourceId: string, now = new Date()) {
  return db.transaction(async trx => {
    const { plan, period } = await entitlementLocked(trx, accountId, now);
    const column = category === "browser" ? "browser_ms" : "proxy_bytes";
    const chargedColumn = category === "browser" ? "browser_charged" : "proxy_charged";
    const rate = category === "browser" ? plan.browser_hour_micros : plan.proxy_gb_micros;
    const prior = (await trx.execute<{quantity:string}>(sql`select quantity from allowance_receipts where account_id=${accountId} and category=${category} and source_id=${sourceId}`)).rows[0];
    if (prior) {
      if (Number(prior.quantity) !== quantity) throw new AppError("metering_conflict", "Metering receipt reused with different usage");
      return browserAllowanceAvailable(trx, accountId);
    }
    const total = Number(period[column]) + quantity;
    const charge = overageMicros(total, Number(plan[column]), rate === null ? null : Number(rate), category === "browser" ? 3600000 : 1000000000);
    const before = overageMicros(Number(period[column]), Number(plan[column]), rate === null ? null : Number(rate), category === "browser" ? 3600000 : 1000000000);
    const delta = charge - before;
    await trx.execute(sql`insert into allowance_receipts(account_id,category,source_id,period_id,plan_revision_id,quantity,charge_micros)
      values(${accountId},${category},${sourceId},${period.id},${plan.id},${quantity},${delta})`);
    if (delta) await appendCreditAdjustmentLocked(trx, { accountId, kind: "adjustment", units: -delta,
      idempotencyKey: `allowance:${period.id}:${category}:${sourceId}`, metadata: { category, planRevisionId: plan.id, periodId: period.id } });
    await trx.execute(sql`update subscription_periods set ${sql.identifier(column)}=${total},${sql.identifier(chargedColumn)}=${Number(period[chargedColumn]) + delta} where id=${period.id}`);
    return total < Number(plan[column]) || rate !== null && (Number(rate) === 0 || (await getCreditBalance(trx, accountId)).availableUnits > 0);
  });
}
export async function browserAllowanceAvailable(db: Db, accountId: string) {
  const { plan, period } = await entitlementLocked(db, accountId);
  const balance = (await getCreditBalance(db, accountId)).availableUnits;
  return (["browser", "proxy"] as const).every(kind => {
    const used = Number(kind === "browser" ? period.browser_ms : period.proxy_bytes);
    const limit = Number(kind === "browser" ? plan.browser_ms : plan.proxy_bytes);
    const rate = kind === "browser" ? plan.browser_hour_micros : plan.proxy_gb_micros;
    return used < limit || rate !== null && (Number(rate) === 0 || balance > 0);
  });
}
