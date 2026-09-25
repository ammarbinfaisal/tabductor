import { assertUsdAccount } from "./billing-prices.js";
import { usdMicros } from "@tabductor/core";
import { AppError, newId } from "@tabductor/core";
import {
  paymentAdjustments,
  paymentPurchases,
  paymentWebhookEvents,
  type Db,
  type PaymentPurchaseRow,
  type PaymentWebhookStatus,
} from "@tabductor/db";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { appendCreditAdjustmentLocked, lockCreditAccount } from "./credits.js";

const creditPackSchema = z.object({
  priceId: z.string().min(1).max(100),
  creditUnits: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const creditPacksSchema = z.array(creditPackSchema).min(1);

export type PaddleCreditPack = z.infer<typeof creditPackSchema>;

export function parsePaddleCreditPacks(raw: string): Map<string, PaddleCreditPack> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new AppError("paddle_credit_packs_invalid", "PADDLE_USD_PACKS_JSON is not valid JSON", { cause });
  }
  const parsed = creditPacksSchema.safeParse(Array.isArray(json)?json.map(({balanceUsd,...r})=>balanceUsd===undefined?r:{...r,creditUnits:usdMicros(String(balanceUsd))}):json);
  if (!parsed.success) throw new AppError("paddle_credit_packs_invalid", "Paddle credit packs are invalid");
  const packs = new Map<string, PaddleCreditPack>();
  for (const pack of parsed.data) {
    if (packs.has(pack.priceId)) throw new AppError("paddle_credit_packs_invalid", `duplicate Paddle price ${pack.priceId}`);
    packs.set(pack.priceId, pack);
  }
  return packs;
}

export type PaddleTransactionClient = {
  createTransaction(input: { priceId: string; purchaseId: string; checkoutUrl?: string; discountId?: string }): Promise<{
    transactionId: string;
    checkoutUrl?: string;
  }>;
};

const createTransactionResponseSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    checkout: z.object({ url: z.string().url().nullable() }).nullable().optional(),
  }),
});

export function createPaddleTransactionClient(input: {
  apiKey: string;
  environment: "sandbox" | "live";
  fetchImpl?: typeof fetch;
}): PaddleTransactionClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.environment === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
  return {
    async createTransaction(request) {
      const response = await fetchImpl(`${baseUrl}/transactions`, {
        method: "POST",
        headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          items: [{ price_id: request.priceId, quantity: 1 }],
          collection_mode: "automatic",
          ...(request.discountId ? {discount_id:request.discountId} : {}),
          currency_code: "USD",
          custom_data: { tabductor_purchase_id: request.purchaseId },
          ...(request.checkoutUrl ? { checkout: { url: request.checkoutUrl } } : {}),
        }),
      });
      if (!response.ok) throw new AppError("paddle_api_error", `Paddle transaction creation failed with HTTP ${response.status}`);
      const parsed = createTransactionResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new AppError("paddle_api_invalid", "Paddle returned an invalid transaction response");
      return {
        transactionId: parsed.data.data.id,
        ...(parsed.data.data.checkout?.url ? { checkoutUrl: parsed.data.data.checkout.url } : {}),
      };
    },
  };
}

export async function createPaddleCreditPurchase(
  db: Db,
  input: { accountId: string; operationId: string; priceId: string; checkoutUrl?: string; discountId?: string },
  deps: { packs: Map<string, PaddleCreditPack>; client: PaddleTransactionClient },
): Promise<PaymentPurchaseRow> {
  await assertUsdAccount(db,input.accountId);
  const pack = deps.packs.get(input.priceId);
  if (!pack) throw new AppError("paddle_price_not_configured", "credit pack price is not configured");
  if (!input.operationId.trim()) throw new AppError("paddle_operation_invalid", "purchase operation id is required");

  const prepared = await db.transaction(async (trx) => {
    const id = newId("purchase");
    const [inserted] = await trx.insert(paymentPurchases).values({
      id,
      accountId: input.accountId,
      operationId: input.operationId,
      priceId: pack.priceId,
      creditUnits: pack.creditUnits,
      discountId: input.discountId??null,
    }).onConflictDoNothing({
      target: [paymentPurchases.accountId, paymentPurchases.operationId],
    }).returning();
    if (inserted) return { purchase: inserted, create: true };
    const [existing] = await trx.select().from(paymentPurchases).where(and(
      eq(paymentPurchases.accountId, input.accountId),
      eq(paymentPurchases.operationId, input.operationId),
    ));
    if (!existing) throw new AppError("paddle_purchase_conflict", "purchase operation could not be resolved");
    if (existing.priceId !== input.priceId || existing.discountId !== (input.discountId??null)) {
      throw new AppError("paddle_purchase_conflict", "purchase operation was already used for another price");
    }
    return { purchase: existing, create: false };
  });
  if (!prepared.create) return prepared.purchase;

  let transaction: Awaited<ReturnType<PaddleTransactionClient["createTransaction"]>>;
  try {
    transaction = await deps.client.createTransaction({
      priceId: pack.priceId,
      purchaseId: prepared.purchase.id,
      ...(input.discountId?{discountId:input.discountId}:{}),
      ...(input.checkoutUrl ? { checkoutUrl: input.checkoutUrl } : {}),
    });
  } catch (error) {
    await db.update(paymentPurchases).set({
      status: "failed",
      lastError: error instanceof Error ? error.message.slice(0, 500) : "Paddle transaction creation failed",
      updatedAt: sql`now()`,
    }).where(and(eq(paymentPurchases.id, prepared.purchase.id), eq(paymentPurchases.status, "creating")));
    throw error;
  }

  const [updated] = await db.update(paymentPurchases).set({
    paddleTransactionId: transaction.transactionId,
    checkoutUrl: transaction.checkoutUrl ?? null,
    status: "pending",
    lastError: null,
    updatedAt: sql`now()`,
  }).where(and(
    eq(paymentPurchases.id, prepared.purchase.id),
    eq(paymentPurchases.status, "creating"),
  )).returning();
  if (!updated) throw new AppError("paddle_purchase_uncertain", "Paddle transaction exists but local purchase ownership changed");
  return updated;
}

const completedTransactionSchema = z.object({
  id: z.string().min(1),
  status: z.literal("completed"),
  custom_data: z.object({ tabductor_purchase_id: z.string().min(1) }),
  currency_code: z.string().min(3).max(3),
  discount_id: z.string().nullable().optional(),
  details: z.object({ totals: z.object({ total: z.string().regex(/^\d+$/) }).passthrough() }).passthrough(),
  items: z.array(z.object({ price_id: z.string().min(1), quantity: z.number().int().positive() })).length(1),
});

const adjustmentSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  status: z.enum(["pending_approval", "approved", "rejected", "reversed"]),
  transaction_id: z.string().min(1),
  currency_code: z.string().length(3),
  totals: z.object({ total: z.string().regex(/^\d+$/) }),
});

const SUPPORTED_ADJUSTMENT_ACTIONS = new Set(["refund", "credit", "chargeback"]);

function proportionalRefundedUnits(amountMinor: number, totalMinor: number, creditUnits: number): number {
  if (amountMinor >= totalMinor) return creditUnits;
  // Round the cumulative money ratio up once, rather than each adjustment independently:
  // no refunded money retains a fractional credit, while several small adjustments cannot
  // compound rounding and remove more than the pack's configured units.
  const numerator = BigInt(amountMinor) * BigInt(creditUnits);
  const units = (numerator + BigInt(totalMinor) - 1n) / BigInt(totalMinor);
  const result = Number(units);
  if (!Number.isSafeInteger(result)) {
    throw new AppError("paddle_adjustment_invalid", "adjustment credit amount is outside the supported range");
  }
  return result;
}

async function setEventStatus(
  db: Db,
  notificationId: string,
  status: PaymentWebhookStatus,
  error?: string,
): Promise<void> {
  await db.update(paymentWebhookEvents).set({
    status,
    attempts: sql`${paymentWebhookEvents.attempts} + 1`,
    lastError: error?.slice(0, 500) ?? null,
    ...(status === "processed" ? { processedAt: sql`now()` } : {}),
  }).where(eq(paymentWebhookEvents.notificationId, notificationId));
}

export async function processPaddleWebhookEvent(
  db: Db,
  notificationId: string,
  packs: Map<string, PaddleCreditPack>,
): Promise<PaymentWebhookStatus> {
  return db.transaction(async (trx) => {
    const [event] = await trx.select().from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.notificationId, notificationId)).for("update");
    if (!event) throw new AppError("paddle_event_not_found", "Paddle webhook event does not exist");
    if (event.status === "processed") return "processed";
    if (event.status === "failed") return "failed";
    if (event.eventType === "adjustment.created" || event.eventType === "adjustment.updated") {
      return processAdjustmentEvent(trx, event, notificationId);
    }
    if (event.eventType !== "transaction.completed") {
      await setEventStatus(trx, notificationId, "processed");
      return "processed";
    }

    const envelope = event.payloadJson as { data?: unknown };
    const parsed = completedTransactionSchema.safeParse(envelope.data);
    if (!parsed.success) {
      await setEventStatus(trx, notificationId, "failed", "invalid completed transaction payload");
      return "failed";
    }
    const transaction = parsed.data;
    const totalMinor = Number(transaction.details.totals.total);
    if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) {
      await setEventStatus(trx, notificationId, "failed", "completed transaction total is outside the supported range");
      return "failed";
    }
    const [purchase] = await trx.select().from(paymentPurchases)
      .where(eq(paymentPurchases.id, transaction.custom_data.tabductor_purchase_id)).for("update");
    if (!purchase) {
      await setEventStatus(trx, notificationId, "pending", "local purchase has not arrived yet");
      return "pending";
    }

    const item = transaction.items[0]!;
    if (item.quantity !== 1 || purchase.priceId !== item.price_id) {
      await setEventStatus(trx, notificationId, "failed", "completed transaction does not match its configured credit pack");
      return "failed";
    }
    if (purchase.paddleTransactionId && purchase.paddleTransactionId !== transaction.id) {
      await setEventStatus(trx, notificationId, "failed", "completed transaction does not match the local purchase");
      return "failed";
    }

    await lockCreditAccount(trx, purchase.accountId);
    await appendCreditAdjustmentLocked(trx, {
      accountId: purchase.accountId,
      kind: "purchase",
      units: purchase.creditUnits,
      idempotencyKey: `paddle:transaction:${transaction.id}:completed`,
      metadata: { transactionId: transaction.id, priceId: item.price_id, purchaseId: purchase.id },
    });
    await trx.update(paymentPurchases).set({
      paddleTransactionId: transaction.id,
      status: "completed",
      totalMinor,
      currencyCode: transaction.currency_code,
      financialJson: transaction.details,
      discountId: transaction.discount_id??purchase.discountId,
      creditedAt: sql`coalesce(${paymentPurchases.creditedAt}, now())`,
      lastError: null,
      updatedAt: sql`now()`,
    }).where(eq(paymentPurchases.id, purchase.id));
    await setEventStatus(trx, notificationId, "processed");
    return "processed";
  });
}

async function processAdjustmentEvent(
  db: Db,
  event: typeof paymentWebhookEvents.$inferSelect,
  notificationId: string,
): Promise<PaymentWebhookStatus> {
  const envelope = event.payloadJson as { data?: unknown };
  const parsed = adjustmentSchema.safeParse(envelope.data);
  if (!parsed.success) {
    await setEventStatus(db, notificationId, "failed", "invalid adjustment payload");
    return "failed";
  }
  const adjustment = parsed.data;
  if (!SUPPORTED_ADJUSTMENT_ACTIONS.has(adjustment.action)) {
    await setEventStatus(db, notificationId, "failed", `unsupported adjustment action ${adjustment.action}`);
    return "failed";
  }
  if (adjustment.status === "reversed") {
    await setEventStatus(db, notificationId, "failed", "reversed adjustments require explicit reversal reconciliation");
    return "failed";
  }
  const amountMinor = Number(adjustment.totals.total);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    await setEventStatus(db, notificationId, "failed", "adjustment total is outside the supported range");
    return "failed";
  }

  const [purchase] = await db.select().from(paymentPurchases)
    .where(eq(paymentPurchases.paddleTransactionId, adjustment.transaction_id)).for("update");
  if (!purchase || !purchase.creditedAt || purchase.totalMinor === null || purchase.currencyCode === null ||
      !["completed", "partially_refunded", "refunded"].includes(purchase.status)) {
    await setEventStatus(db, notificationId, "pending", "completed local purchase has not arrived yet");
    return "pending";
  }
  if (purchase.currencyCode !== adjustment.currency_code) {
    await setEventStatus(db, notificationId, "failed", "adjustment currency does not match the purchase");
    return "failed";
  }

  const [existing] = await db.select().from(paymentAdjustments)
    .where(eq(paymentAdjustments.paddleAdjustmentId, adjustment.id)).for("update");
  if (existing && (
    existing.purchaseId !== purchase.id ||
    existing.paddleTransactionId !== adjustment.transaction_id ||
    existing.action !== adjustment.action ||
    existing.amountMinor !== amountMinor ||
    existing.currencyCode !== adjustment.currency_code
  )) {
    await setEventStatus(db, notificationId, "failed", "adjustment identity was reused with different terms");
    return "failed";
  }
  if (existing && existing.lastOccurredAt.getTime() > event.occurredAt.getTime()) {
    await setEventStatus(db, notificationId, "processed");
    return "processed";
  }
  if (existing?.status === "approved" && adjustment.status !== "approved") {
    await setEventStatus(db, notificationId, "failed", "approved adjustment cannot move to a non-approved state");
    return "failed";
  }
  if (existing?.status === "rejected" && adjustment.status !== "rejected") {
    await setEventStatus(db, notificationId, "failed", "rejected adjustment cannot change state");
    return "failed";
  }

  if (adjustment.status !== "approved") {
    if (existing) {
      await db.update(paymentAdjustments).set({
        status: adjustment.status,
        lastEventId: event.eventId,
        lastOccurredAt: event.occurredAt,
        updatedAt: sql`now()`,
      }).where(eq(paymentAdjustments.paddleAdjustmentId, adjustment.id));
    } else {
      await db.insert(paymentAdjustments).values({
        paddleAdjustmentId: adjustment.id,
        purchaseId: purchase.id,
        paddleTransactionId: adjustment.transaction_id,
        action: adjustment.action as "refund" | "credit" | "chargeback",
        status: adjustment.status,
        amountMinor,
        currencyCode: adjustment.currency_code,
        lastEventId: event.eventId,
        lastOccurredAt: event.occurredAt,
      });
    }
    await setEventStatus(db, notificationId, "processed");
    return "processed";
  }

  if (existing?.status === "approved") {
    await db.update(paymentAdjustments).set({
      lastEventId: event.eventId,
      lastOccurredAt: event.occurredAt,
      updatedAt: sql`now()`,
    }).where(eq(paymentAdjustments.paddleAdjustmentId, adjustment.id));
    await setEventStatus(db, notificationId, "processed");
    return "processed";
  }

  const [approved] = await db.select({
    amountMinor: sql<number>`coalesce(sum(${paymentAdjustments.amountMinor}), 0)::double precision`,
  }).from(paymentAdjustments).where(and(
    eq(paymentAdjustments.purchaseId, purchase.id),
    eq(paymentAdjustments.status, "approved"),
    ne(paymentAdjustments.paddleAdjustmentId, adjustment.id),
  ));
  const cumulativeAmount = (approved?.amountMinor ?? 0) + amountMinor;
  if (!Number.isSafeInteger(cumulativeAmount) || cumulativeAmount > purchase.totalMinor) {
    await setEventStatus(db, notificationId, "failed", "approved adjustments exceed the purchase total");
    return "failed";
  }
  const targetRefundedUnits = proportionalRefundedUnits(
    cumulativeAmount,
    purchase.totalMinor,
    purchase.creditUnits,
  );
  const debitedUnits = targetRefundedUnits - purchase.refundedUnits;
  if (!Number.isSafeInteger(debitedUnits) || debitedUnits < 0) {
    await setEventStatus(db, notificationId, "failed", "adjustment credit accounting conflicts with the purchase");
    return "failed";
  }

  await lockCreditAccount(db, purchase.accountId);
  if (debitedUnits > 0) {
    await appendCreditAdjustmentLocked(db, {
      accountId: purchase.accountId,
      kind: "refund",
      units: -debitedUnits,
      idempotencyKey: `paddle:adjustment:${adjustment.id}:approved`,
      metadata: {
        adjustmentId: adjustment.id,
        transactionId: adjustment.transaction_id,
        purchaseId: purchase.id,
        action: adjustment.action,
        amountMinor,
        currencyCode: adjustment.currency_code,
      },
    });
  }
  if (existing) {
    await db.update(paymentAdjustments).set({
      status: "approved",
      debitedUnits,
      lastEventId: event.eventId,
      lastOccurredAt: event.occurredAt,
      updatedAt: sql`now()`,
    }).where(eq(paymentAdjustments.paddleAdjustmentId, adjustment.id));
  } else {
    await db.insert(paymentAdjustments).values({
      paddleAdjustmentId: adjustment.id,
      purchaseId: purchase.id,
      paddleTransactionId: adjustment.transaction_id,
      action: adjustment.action as "refund" | "credit" | "chargeback",
      status: "approved",
      amountMinor,
      currencyCode: adjustment.currency_code,
      debitedUnits,
      lastEventId: event.eventId,
      lastOccurredAt: event.occurredAt,
    });
  }
  await db.update(paymentPurchases).set({
    refundedUnits: targetRefundedUnits,
    status: targetRefundedUnits === purchase.creditUnits ? "refunded" : "partially_refunded",
    lastError: null,
    updatedAt: sql`now()`,
  }).where(eq(paymentPurchases.id, purchase.id));
  await setEventStatus(db, notificationId, "processed");
  return "processed";
}

/** Retries durable received/pending deliveries so arrival order never determines crediting. */
export async function processPendingPaddleWebhookEvents(
  db: Db,
  packs: Map<string, PaddleCreditPack>,
  limit = 100,
): Promise<{ processed: number; pending: number; failed: number }> {
  const events = await db.select({ notificationId: paymentWebhookEvents.notificationId })
    .from(paymentWebhookEvents)
    .where(inArray(paymentWebhookEvents.status, ["received", "pending"]))
    .orderBy(asc(paymentWebhookEvents.createdAt))
    .limit(Math.max(1, Math.min(limit, 500)));
  const counts = { processed: 0, pending: 0, failed: 0 };
  for (const event of events) {
    const status = await processPaddleWebhookEvent(db, event.notificationId, packs);
    counts[status === "received" ? "pending" : status] += 1;
  }
  return counts;
}
