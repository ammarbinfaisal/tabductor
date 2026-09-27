import { createHmac } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { creditLedgerEntries, paymentAdjustments, paymentPurchases, paymentWebhookEvents } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createPaddleCreditPurchase, getCreditBalance, ingestPaddleWebhook, processPaddleWebhookEvent, processPendingPaddleWebhookEvents, reserveCredits, resolveAccountIdentity, settleCreditReservation, type PaddleCreditPack, type PaddleTransactionClient } from "@tabductor/engine";

import { eq } from "drizzle-orm";

let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });

const packs = new Map<string, PaddleCreditPack>([["pri_100", { priceId: "pri_100", creditUnits: 100 }]]);
const secret = "pdl_ntfset_purchase_secret";
const now = new Date("2026-09-18T06:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);

async function completedDelivery(input: { eventId: string; notificationId: string; purchaseId: string; transactionId: string; priceId?: string; total?: string; discountId?: string }) {
  const rawBody = JSON.stringify({
    event_id: input.eventId,
    event_type: "transaction.completed",
    occurred_at: now.toISOString(),
    notification_id: input.notificationId,
    data: {
      id: input.transactionId,
      status: "completed",
      custom_data: { tabductor_purchase_id: input.purchaseId, credit_units: 999_999 },
      currency_code: "USD",
      discount_id: input.discountId,
      details: { totals: { total: input.total??"500",tax:"0",fee:"0" } },
      items: [{ price_id: input.priceId ?? "pri_100", quantity: 1 }],
    },
  });
  const h1 = createHmac("sha256", secret).update(`${timestamp}:${rawBody}`, "utf8").digest("hex");
  return ingestPaddleWebhook(handle.db, {
    rawBody,
    signatureHeader: `ts=${timestamp};h1=${h1}`,
    secret,
    now,
  });
}

async function adjustmentDelivery(input: {
  eventId: string;
  notificationId: string;
  adjustmentId: string;
  transactionId: string;
  action: "refund" | "credit" | "chargeback" | "chargeback_reverse";
  status: "pending_approval" | "approved" | "rejected" | "reversed";
  total: string;
  currencyCode?: string;
  eventType?: "adjustment.created" | "adjustment.updated";
}) {
  const rawBody = JSON.stringify({
    event_id: input.eventId,
    event_type: input.eventType ?? "adjustment.created",
    occurred_at: now.toISOString(),
    notification_id: input.notificationId,
    data: {
      id: input.adjustmentId,
      action: input.action,
      status: input.status,
      type: input.total === "500" ? "full" : "partial",
      transaction_id: input.transactionId,
      currency_code: input.currencyCode ?? "USD",
      totals: { total: input.total },
      items: [{
        id: `${input.adjustmentId}_item`,
        item_id: "txnitm_credit_pack",
        type: input.total === "500" ? "full" : "partial",
        totals: { total: input.total, subtotal: input.total, tax: "0" },
      }],
    },
  });
  const h1 = createHmac("sha256", secret).update(`${timestamp}:${rawBody}`, "utf8").digest("hex");
  return ingestPaddleWebhook(handle.db, {
    rawBody,
    signatureHeader: `ts=${timestamp};h1=${h1}`,
    secret,
    now,
  });
}

async function completedPurchase(subject: string, transactionId: string) {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject });
  const purchase = await createPaddleCreditPurchase(handle.db, {
    accountId,
    operationId: `checkout-${subject}`,
    priceId: "pri_100",
  }, {
    packs,
    client: { createTransaction: async () => ({ transactionId }) },
  });
  const completion = await completedDelivery({
    eventId: `evt_${subject}_completed`,
    notificationId: `ntf_${subject}_completed`,
    purchaseId: purchase.id,
    transactionId,
  });
  expect(await processPaddleWebhookEvent(handle.db, completion.event.notificationId, packs)).toBe("processed");
  return { accountId, purchase };
}

it("creates one server-owned transaction per idempotent purchase operation", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "paddle_create" });
  const createTransaction = vi.fn<PaddleTransactionClient["createTransaction"]>(async () => ({
    transactionId: "txn_create_once",
    checkoutUrl: "https://checkout.paddle.test/txn_create_once",
  }));
  const deps = { packs, client: { createTransaction } };
  const input = { accountId, operationId: "checkout-click-1", priceId: "pri_100" };
  const first = await createPaddleCreditPurchase(handle.db, input, deps);
  const duplicate = await createPaddleCreditPurchase(handle.db, input, deps);

  expect(duplicate.id).toBe(first.id);
  expect(first).toMatchObject({
    status: "pending",
    paddleTransactionId: "txn_create_once",
    creditUnits: 100,
  });
  expect(createTransaction).toHaveBeenCalledTimes(1);
  expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({
    priceId: "pri_100",
    purchaseId: first.id,
  }));
});

it("credits a completed transaction exactly once from the configured price mapping", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "paddle_complete" });
  const purchase = await createPaddleCreditPurchase(handle.db, {
    accountId,
    operationId: "checkout-complete",
    priceId: "pri_100",
  }, {
    packs,
    client: { createTransaction: async () => ({ transactionId: "txn_complete" }) },
  });
  const delivery = await completedDelivery({
    eventId: "evt_complete",
    notificationId: "ntf_complete",
    purchaseId: purchase.id,
    transactionId: "txn_complete",
  });

  expect(await processPaddleWebhookEvent(handle.db, delivery.event.notificationId, packs)).toBe("processed");
  expect(await processPaddleWebhookEvent(handle.db, delivery.event.notificationId, packs)).toBe("processed");
  expect(await getCreditBalance(handle.db, accountId)).toEqual({
    availableUnits: 100,
    reservedUnits: 0,
    totalUnits: 100,
  });
  expect(await handle.db.select().from(creditLedgerEntries).where(eq(
    creditLedgerEntries.idempotencyKey,
    "paddle:transaction:txn_complete:completed",
  ))).toHaveLength(1);
  const [completed] = await handle.db.select().from(paymentPurchases).where(eq(paymentPurchases.id, purchase.id));
  expect(completed).toMatchObject({ status: "completed", totalMinor: 500, currencyCode: "USD" });
});

it("keeps an out-of-order completion pending and rejects price mismatches", async () => {
  const missing = await completedDelivery({
    eventId: "evt_early",
    notificationId: "ntf_early",
    purchaseId: "purchase_not_here_yet",
    transactionId: "txn_early",
  });
  expect(await processPaddleWebhookEvent(handle.db, missing.event.notificationId, packs)).toBe("pending");
  const [pending] = await handle.db.select().from(paymentWebhookEvents)
    .where(eq(paymentWebhookEvents.notificationId, missing.event.notificationId));
  expect(pending).toMatchObject({ status: "pending", attempts: 1 });

  const earlyAccount = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "paddle_early" });
  await handle.db.insert(paymentPurchases).values({
    id: "purchase_not_here_yet",
    accountId: earlyAccount,
    operationId: "checkout-early",
    priceId: "pri_100",
    creditUnits: 100,
  });
  expect(await processPendingPaddleWebhookEvents(handle.db, packs)).toMatchObject({ processed: 1 });
  expect((await getCreditBalance(handle.db, earlyAccount)).availableUnits).toBe(100);

  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "paddle_mismatch" });
  const purchase = await createPaddleCreditPurchase(handle.db, {
    accountId,
    operationId: "checkout-mismatch",
    priceId: "pri_100",
  }, {
    packs,
    client: { createTransaction: async () => ({ transactionId: "txn_mismatch" }) },
  });
  const mismatch = await completedDelivery({
    eventId: "evt_mismatch",
    notificationId: "ntf_mismatch",
    purchaseId: purchase.id,
    transactionId: "txn_mismatch",
    priceId: "pri_unconfigured",
  });
  expect(await processPaddleWebhookEvent(handle.db, mismatch.event.notificationId, packs)).toBe("failed");
  expect((await getCreditBalance(handle.db, accountId)).availableUnits).toBe(0);
});

it("accounts for approved partial credits, chargebacks, and refunds cumulatively", async () => {
  const { accountId, purchase } = await completedPurchase("paddle_partial_adjustments", "txn_partial_adjustments");
  const adjustments = [
    { id: "adj_partial_credit", action: "credit" as const, total: "101", debit: -21 },
    { id: "adj_partial_chargeback", action: "chargeback" as const, total: "99", debit: -19 },
    { id: "adj_partial_refund", action: "refund" as const, total: "300", debit: -60 },
  ];
  for (const [index, adjustment] of adjustments.entries()) {
    const delivery = await adjustmentDelivery({
      eventId: `evt_partial_${index}`,
      notificationId: `ntf_partial_${index}`,
      adjustmentId: adjustment.id,
      transactionId: "txn_partial_adjustments",
      action: adjustment.action,
      status: "approved",
      total: adjustment.total,
    });
    expect(await processPaddleWebhookEvent(handle.db, delivery.event.notificationId, packs)).toBe("processed");
  }

  expect(await getCreditBalance(handle.db, accountId)).toMatchObject({ availableUnits: 0, totalUnits: 0 });
  const [updated] = await handle.db.select().from(paymentPurchases).where(eq(paymentPurchases.id, purchase.id));
  expect(updated).toMatchObject({ status: "refunded", refundedUnits: 100 });
  const rows = await handle.db.select().from(paymentAdjustments).where(eq(paymentAdjustments.purchaseId, purchase.id));
  expect(rows.map((row) => ({ action: row.action, amount: row.amountMinor, units: row.debitedUnits })))
    .toEqual(expect.arrayContaining([
      { action: "credit", amount: 101, units: 21 },
      { action: "chargeback", amount: 99, units: 19 },
      { action: "refund", amount: 300, units: 60 },
    ]));
  for (const adjustment of adjustments) {
    const [entry] = await handle.db.select().from(creditLedgerEntries).where(eq(
      creditLedgerEntries.idempotencyKey,
      `paddle:adjustment:${adjustment.id}:approved`,
    ));
    expect(entry?.units).toBe(adjustment.debit);
  }
});

it("waits for refund approval and debits an approved adjustment exactly once", async () => {
  const { accountId, purchase } = await completedPurchase("paddle_approval", "txn_approval");
  const pending = await adjustmentDelivery({
    eventId: "evt_refund_pending",
    notificationId: "ntf_refund_pending",
    adjustmentId: "adj_refund_approval",
    transactionId: "txn_approval",
    action: "refund",
    status: "pending_approval",
    total: "200",
  });
  expect(await processPaddleWebhookEvent(handle.db, pending.event.notificationId, packs)).toBe("processed");
  expect((await getCreditBalance(handle.db, accountId)).availableUnits).toBe(100);

  const approved = await adjustmentDelivery({
    eventId: "evt_refund_approved",
    notificationId: "ntf_refund_approved",
    adjustmentId: "adj_refund_approval",
    transactionId: "txn_approval",
    action: "refund",
    status: "approved",
    total: "200",
    eventType: "adjustment.updated",
  });
  expect(await processPaddleWebhookEvent(handle.db, approved.event.notificationId, packs)).toBe("processed");
  expect(await processPaddleWebhookEvent(handle.db, approved.event.notificationId, packs)).toBe("processed");
  expect((await getCreditBalance(handle.db, accountId)).availableUnits).toBe(60);
  const [updated] = await handle.db.select().from(paymentPurchases).where(eq(paymentPurchases.id, purchase.id));
  expect(updated).toMatchObject({ status: "partially_refunded", refundedUnits: 40 });
  expect(await handle.db.select().from(creditLedgerEntries).where(eq(
    creditLedgerEntries.idempotencyKey,
    "paddle:adjustment:adj_refund_approval:approved",
  ))).toHaveLength(1);
});

it("allows an approved chargeback to create debt after purchased credits were spent", async () => {
  const { accountId } = await completedPurchase("paddle_debt", "txn_debt");
  const reservation = await reserveCredits(handle.db, {
    accountId,
    operationId: "paddle-debt-spend",
    category: "browser",
    units: 80,
  });
  await settleCreditReservation(handle.db, { accountId, reservationId: reservation.id, actualUnits: 80 });
  const chargeback = await adjustmentDelivery({
    eventId: "evt_debt_chargeback",
    notificationId: "ntf_debt_chargeback",
    adjustmentId: "adj_debt_chargeback",
    transactionId: "txn_debt",
    action: "chargeback",
    status: "approved",
    total: "500",
  });
  expect(await processPaddleWebhookEvent(handle.db, chargeback.event.notificationId, packs)).toBe("processed");
  expect(await getCreditBalance(handle.db, accountId)).toEqual({
    availableUnits: -80,
    reservedUnits: 0,
    totalUnits: -80,
  });
});

it("retries adjustments that arrive before completion and rejects inconsistent money", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "paddle_adjustment_early" });
  const purchase = await createPaddleCreditPurchase(handle.db, {
    accountId,
    operationId: "checkout-adjustment-early",
    priceId: "pri_100",
  }, {
    packs,
    client: { createTransaction: async () => ({ transactionId: "txn_adjustment_early" }) },
  });
  const early = await adjustmentDelivery({
    eventId: "evt_adjustment_early",
    notificationId: "ntf_adjustment_early",
    adjustmentId: "adj_adjustment_early",
    transactionId: "txn_adjustment_early",
    action: "refund",
    status: "approved",
    total: "100",
  });
  expect(await processPaddleWebhookEvent(handle.db, early.event.notificationId, packs)).toBe("pending");

  const completion = await completedDelivery({
    eventId: "evt_adjustment_early_completed",
    notificationId: "ntf_adjustment_early_completed",
    purchaseId: purchase.id,
    transactionId: "txn_adjustment_early",
  });
  expect(await processPaddleWebhookEvent(handle.db, completion.event.notificationId, packs)).toBe("processed");
  expect(await processPendingPaddleWebhookEvents(handle.db, packs)).toMatchObject({ processed: 1 });
  expect((await getCreditBalance(handle.db, accountId)).availableUnits).toBe(80);

  const wrongCurrency = await adjustmentDelivery({
    eventId: "evt_adjustment_currency",
    notificationId: "ntf_adjustment_currency",
    adjustmentId: "adj_adjustment_currency",
    transactionId: "txn_adjustment_early",
    action: "refund",
    status: "approved",
    total: "10",
    currencyCode: "EUR",
  });
  expect(await processPaddleWebhookEvent(handle.db, wrongCurrency.event.notificationId, packs)).toBe("failed");

  const excessive = await adjustmentDelivery({
    eventId: "evt_adjustment_excessive",
    notificationId: "ntf_adjustment_excessive",
    adjustmentId: "adj_adjustment_excessive",
    transactionId: "txn_adjustment_early",
    action: "refund",
    status: "approved",
    total: "450",
  });
  expect(await processPaddleWebhookEvent(handle.db, excessive.event.notificationId, packs)).toBe("failed");

  const unsupportedReversal = await adjustmentDelivery({
    eventId: "evt_adjustment_reversal",
    notificationId: "ntf_adjustment_reversal",
    adjustmentId: "adj_adjustment_reversal",
    transactionId: "txn_adjustment_early",
    action: "chargeback_reverse",
    status: "approved",
    total: "100",
  });
  expect(await processPaddleWebhookEvent(handle.db, unsupportedReversal.event.notificationId, packs)).toBe("failed");
  expect((await getCreditBalance(handle.db, accountId)).availableUnits).toBe(80);
});

it("preserves the promised USD grant after pack edits and a fully discounted checkout",async()=>{
 const accountId=await resolveAccountIdentity(handle.db,{provider:"fixture",subject:"paddle-free"});
 const original=new Map([["pri_free",{priceId:"pri_free",creditUnits:10000000}]]);
 const purchase=await createPaddleCreditPurchase(handle.db,{accountId,operationId:"free",priceId:"pri_free",discountId:"dsc_free"},{packs:original,client:{createTransaction:async()=>({transactionId:"txn_free"})}});
 const delivery=await completedDelivery({eventId:"evt_free",notificationId:"ntf_free",purchaseId:purchase.id,transactionId:"txn_free",priceId:"pri_free",total:"0",discountId:"dsc_free"});
 expect(await processPaddleWebhookEvent(handle.db,delivery.event.notificationId,new Map())).toBe("processed");
 expect((await getCreditBalance(handle.db,accountId)).availableUnits).toBe(10000000);
 expect((await handle.db.select().from(paymentPurchases).where(eq(paymentPurchases.id,purchase.id)))[0]).toMatchObject({creditUnits:10000000,totalMinor:0,discountId:"dsc_free",financialJson:{totals:{total:"0",fee:"0",tax:"0"}}});
});
