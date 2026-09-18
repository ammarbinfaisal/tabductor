import { AppError, newId } from "@tabductor/core";
import {
  paymentPurchases,
  paymentWebhookEvents,
  type Db,
  type PaymentPurchaseRow,
  type PaymentWebhookStatus,
} from "@tabductor/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
    throw new AppError("paddle_credit_packs_invalid", "PADDLE_CREDIT_PACKS_JSON is not valid JSON", { cause });
  }
  const parsed = creditPacksSchema.safeParse(json);
  if (!parsed.success) throw new AppError("paddle_credit_packs_invalid", "Paddle credit packs are invalid");
  const packs = new Map<string, PaddleCreditPack>();
  for (const pack of parsed.data) {
    if (packs.has(pack.priceId)) throw new AppError("paddle_credit_packs_invalid", `duplicate Paddle price ${pack.priceId}`);
    packs.set(pack.priceId, pack);
  }
  return packs;
}

export type PaddleTransactionClient = {
  createTransaction(input: { priceId: string; purchaseId: string; checkoutUrl?: string }): Promise<{
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
  input: { accountId: string; operationId: string; priceId: string; checkoutUrl?: string },
  deps: { packs: Map<string, PaddleCreditPack>; client: PaddleTransactionClient },
): Promise<PaymentPurchaseRow> {
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
    }).onConflictDoNothing({
      target: [paymentPurchases.accountId, paymentPurchases.operationId],
    }).returning();
    if (inserted) return { purchase: inserted, create: true };
    const [existing] = await trx.select().from(paymentPurchases).where(and(
      eq(paymentPurchases.accountId, input.accountId),
      eq(paymentPurchases.operationId, input.operationId),
    ));
    if (!existing) throw new AppError("paddle_purchase_conflict", "purchase operation could not be resolved");
    if (existing.priceId !== input.priceId) {
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
  details: z.object({ totals: z.object({ total: z.string().regex(/^\d+$/) }) }),
  items: z.array(z.object({ price_id: z.string().min(1), quantity: z.number().int().positive() })).length(1),
});

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
    if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
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
    const pack = packs.get(item.price_id);
    if (!pack || item.quantity !== 1 || purchase.priceId !== item.price_id || purchase.creditUnits !== pack.creditUnits) {
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
      units: pack.creditUnits,
      idempotencyKey: `paddle:transaction:${transaction.id}:completed`,
      metadata: { transactionId: transaction.id, priceId: item.price_id, purchaseId: purchase.id },
    });
    await trx.update(paymentPurchases).set({
      paddleTransactionId: transaction.id,
      status: "completed",
      totalMinor,
      currencyCode: transaction.currency_code,
      creditedAt: sql`coalesce(${paymentPurchases.creditedAt}, now())`,
      lastError: null,
      updatedAt: sql`now()`,
    }).where(eq(paymentPurchases.id, purchase.id));
    await setEventStatus(trx, notificationId, "processed");
    return "processed";
  });
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
