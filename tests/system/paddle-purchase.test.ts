import { createHmac } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { creditLedgerEntries, paymentPurchases, paymentWebhookEvents } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  createPaddleCreditPurchase,
  getCreditBalance,
  ingestPaddleWebhook,
  processPaddleWebhookEvent,
  processPendingPaddleWebhookEvents,
  resolveAccountIdentity,
  type PaddleCreditPack,
  type PaddleTransactionClient,
} from "@tabductor/engine";
import { eq } from "drizzle-orm";

let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });

const packs = new Map<string, PaddleCreditPack>([["pri_100", { priceId: "pri_100", creditUnits: 100 }]]);
const secret = "pdl_ntfset_purchase_secret";
const now = new Date("2026-09-18T06:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);

async function completedDelivery(input: { eventId: string; notificationId: string; purchaseId: string; transactionId: string; priceId?: string }) {
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
      details: { totals: { total: "500" } },
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
