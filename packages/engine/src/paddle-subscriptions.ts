import { AppError, newId } from "@tabductor/core";
import { type Db, type PaymentWebhookEventRow } from "@tabductor/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { entitlementLocked, transitionEntitlement, type PlanRevision, type Subscription } from "./subscriptions.js";
import { lockCreditAccount } from "./credits.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type SubscriptionCheckout = { id: string; account_id: string; plan_revision_id: string; operation_id: string; transaction_id: string | null; checkout_url: string | null; status: string };
export async function paddleRequest(path: string, method: string, body?: unknown, request = fetch): Promise<Record<string, unknown>> {
  const key = process.env.PADDLE_API_KEY;
  if (!key) throw new AppError("paddle_unconfigured", "Paddle billing is not configured");
  const sandbox = process.env.PADDLE_ENVIRONMENT === "sandbox" || (!process.env.PADDLE_ENVIRONMENT && key.startsWith("pdl_sdbx_"));
  const response = await request(`https://${sandbox ? "sandbox-api" : "api"}.paddle.com${path}`, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new AppError("paddle_api_error", `Paddle returned HTTP ${response.status}`);
  return record(record(await response.json()).data);
}

export async function createSubscriptionCheckout(db: Db, input: { accountId: string; planId: string; operationId: string; verifiedEmails: string[]; offerId?: string }, request = fetch) {
  const checkout = await db.transaction(async trx => {
    const { subscription } = await entitlementLocked(trx, input.accountId);
    if (subscription.paddle_subscription_id) throw new AppError("subscription_exists", "Manage the existing subscription to change plans");
    const plan = (await trx.execute<PlanRevision>(sql`select * from plan_revisions where id=${input.planId} and enabled`)).rows[0];
    if (!plan?.paddle_price_id) throw new AppError("plan_unavailable", "This plan is not available for checkout yet");
    if (!plan.public) {
      const offer = (await trx.execute<{ email: string; claimed_account_id: string | null }>(sql`select * from custom_plan_offers
        where id=${input.offerId ?? ""} and plan_revision_id=${plan.id} and expires_at>now() for update`)).rows[0];
      if (!offer || !input.verifiedEmails.map(email => email.toLowerCase()).includes(offer.email) || offer.claimed_account_id && offer.claimed_account_id !== input.accountId)
        throw new AppError("offer_unavailable", "This offer requires its matching verified email address");
      await trx.execute(sql`update custom_plan_offers set claimed_account_id=${input.accountId} where id=${input.offerId!}`);
    }
    const prior = (await trx.execute<SubscriptionCheckout>(sql`select * from subscription_checkouts where account_id=${input.accountId} and operation_id=${input.operationId}`)).rows[0];
    if (prior) {
      if (prior.plan_revision_id !== plan.id) throw new AppError("checkout_conflict", "Checkout ID already used for another plan");
      return { row: prior, price: plan.paddle_price_id, create: false };
    }
    const row = (await trx.execute<SubscriptionCheckout>(sql`insert into subscription_checkouts(id,account_id,plan_revision_id,operation_id)
      values(${newId("subcheckout")},${input.accountId},${plan.id},${input.operationId}) returning *`)).rows[0]!;
    return { row, price: plan.paddle_price_id, create: true };
  });
  if (!checkout.create) return checkout.row;
  // Persist intent before the network call. An uncertain checkout is never automatically recreated.
  const data = await paddleRequest("/transactions", "POST", { items: [{ price_id: checkout.price, quantity: 1 }], currency_code: "USD",
    collection_mode: "automatic", custom_data: { tabductor_subscription_checkout_id: checkout.row.id },
    ...(process.env.PADDLE_CHECKOUT_URL ? { checkout: { url: process.env.PADDLE_CHECKOUT_URL } } : {}),
  }, request);
  if (typeof data.id !== "string") throw new AppError("paddle_response_invalid", "Paddle did not return a transaction");
  const url = record(data.checkout).url;
  return (await db.execute<SubscriptionCheckout>(sql`update subscription_checkouts set transaction_id=${data.id},checkout_url=${typeof url === "string" ? url : null},
    status=case when status='creating' then 'pending' else status end where id=${checkout.row.id} returning *`)).rows[0]!;
}

export async function changeSubscription(db: Db, accountId: string, planId: string | null, request = fetch) {
  return db.transaction(async trx => {
    const { subscription, plan } = await entitlementLocked(trx, accountId);
    if (!subscription.paddle_subscription_id) throw new AppError("subscription_missing", "No paid subscription to manage");
    const path = `/subscriptions/${encodeURIComponent(subscription.paddle_subscription_id)}`;
    if (planId === null) {
      await paddleRequest(`${path}/cancel`, "POST", { effective_from: "next_billing_period" }, request);
      await trx.execute(sql`update account_subscriptions set cancel_at_end=true where account_id=${accountId}`);
      return { scheduled: true };
    }
    const target = (await trx.execute<PlanRevision>(sql`select * from plan_revisions where id=${planId} and enabled and public`)).rows[0];
    if (!target?.paddle_price_id) throw new AppError("plan_unavailable", "Plan unavailable");
    const downgrade = Number(target.monthly_micros) < Number(plan.monthly_micros);
    await paddleRequest(path, "PATCH", { items: [{ price_id: target.paddle_price_id, quantity: 1 }],
      proration_billing_mode: downgrade ? "full_next_billing_period" : "prorated_immediately",
      on_payment_failure: "prevent_change" }, request);
    // Entitlements change only from completed transactions, so a downgrade retains the current plan until renewal.
    await trx.execute(sql`update account_subscriptions set pending_revision_id=${target.id} where account_id=${accountId}`);
    return { scheduled: downgrade };
  });
}

const completed = z.object({
  id: z.string(), subscription_id: z.string(), status: z.literal("completed"), currency_code: z.literal("USD"),
  billing_period: z.object({ starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }) }),
  items: z.array(z.object({ price_id: z.string(), quantity: z.literal(1) })).length(1),
  details: z.object({ totals: z.object({ total: z.string().regex(/^\d+$/) }) }),
  custom_data: z.record(z.unknown()).nullable().optional(),
});

/** Runs only inside the verified inbox transaction. Returns false for wallet purchases. */
export async function processSubscriptionEvent(db: Db, event: PaymentWebhookEventRow): Promise<boolean> {
  const data = record(record(event.payloadJson).data);
  const custom = record(data.custom_data);
  if (event.eventType.startsWith("subscription.")) {
    const subscription = (await db.execute<Subscription>(sql`select * from account_subscriptions where paddle_subscription_id=${String(data.id)}`)).rows[0];
    if (!subscription) {
      // Payment may arrive later; subscription metadata is retried from the inbox.
      if (custom.tabductor_subscription_checkout_id) throw new AppError("subscription_payment_pending", "Subscription payment has not arrived yet");
      return true;
    }
    await lockCreditAccount(db, subscription.account_id);
    if (!subscription.provider_updated_at || event.occurredAt > new Date(subscription.provider_updated_at)) {
      const status = typeof data.status === "string" ? data.status : subscription.status;
      await db.execute(sql`update account_subscriptions set status=${status},provider_updated_at=${event.occurredAt},
        cancel_at_end=${record(data.scheduled_change).action === "cancel"} where account_id=${subscription.account_id}`);
    }
    return true;
  }
  if (event.eventType !== "transaction.completed" || !data.subscription_id) return false;
  const tx = completed.parse(data);
  const checkout = (await db.execute<SubscriptionCheckout>(sql`select * from subscription_checkouts where id=${String(custom.tabductor_subscription_checkout_id ?? "")}`)).rows[0];
  const owner = (await db.execute<Subscription>(sql`select * from account_subscriptions where paddle_subscription_id=${tx.subscription_id}`)).rows[0];
  const accountId = owner?.account_id ?? checkout?.account_id;
  if (!accountId) throw new AppError("subscription_owner_pending", "Subscription checkout has not arrived yet");
  await lockCreditAccount(db, accountId);
  const current = (await db.execute<Subscription>(sql`select * from account_subscriptions where account_id=${accountId} for update`)).rows[0]!;
  current.period_start = new Date(current.period_start); current.period_end = new Date(current.period_end);
  if (current.paddle_subscription_id && current.paddle_subscription_id !== tx.subscription_id) throw new AppError("subscription_conflict", "Account already has another subscription");
  const plan = (await db.execute<PlanRevision>(sql`select * from plan_revisions where paddle_price_id=${tx.items[0]!.price_id}`)).rows[0];
  if (!plan || !owner && (!checkout || checkout.plan_revision_id !== plan.id || checkout.transaction_id && checkout.transaction_id !== tx.id))
    throw new AppError("subscription_price_mismatch", "Subscription does not match the authorized checkout");
  const amount = Number(tx.details.totals.total) * 10000;
  if (!Number.isSafeInteger(amount)) throw new Error("Invalid subscription total");
  const start = new Date(tx.billing_period.starts_at), end = new Date(tx.billing_period.ends_at);
  if (end <= start) throw new Error("Invalid subscription period");
  const inserted = await db.execute(sql`insert into subscription_transactions(id,account_id,plan_revision_id,subscription_id,period_start,period_end,amount_micros,occurred_at)
    values(${tx.id},${accountId},${plan.id},${tx.subscription_id},${start},${end},${amount},${event.occurredAt}) on conflict do nothing returning id`);
  if (!inserted.rows.length) return true;
  // A late old payment is recorded as revenue but cannot roll back a newer paid period/upgrade.
  const newer = await db.execute(sql`select 1 from subscription_transactions where account_id=${accountId} and occurred_at>${event.occurredAt} limit 1`);
  if (!newer.rows.length && (end >= current.period_end || !owner)) {
    const samePeriod = Boolean(owner && start < current.period_end && end.getTime() === current.period_end.getTime());
    if (plan.id !== current.plan_revision_id) await transitionEntitlement(db, accountId, plan.id, new Date(), "paid_transaction");
    await db.execute(sql`update account_subscriptions set plan_revision_id=${plan.id},paddle_subscription_id=${tx.subscription_id},status='active',
      period_start=${samePeriod ? current.period_start : start},period_end=${end},pending_revision_id=null where account_id=${accountId}`);
    // Free-to-paid upgrades preserve consumption already incurred during the overlapping period.
    if (!owner) await db.execute(sql`update subscription_periods set starts_at=${start},ends_at=${end} where account_id=${accountId} and starts_at=${current.period_start}`);
  }
  if (checkout) await db.execute(sql`update subscription_checkouts set transaction_id=${tx.id},status='completed' where id=${checkout.id}`);
  return true;
}
