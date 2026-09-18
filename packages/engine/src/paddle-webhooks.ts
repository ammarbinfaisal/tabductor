import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@tabductor/core";
import { paymentWebhookEvents, type Db, type PaymentWebhookEventRow } from "@tabductor/db";
import { or, eq } from "drizzle-orm";
import { z } from "zod";

const paddleEventSchema = z.object({
  event_id: z.string().min(1).max(100),
  event_type: z.string().min(1).max(100),
  occurred_at: z.string().datetime({ offset: true }),
  notification_id: z.string().min(1).max(100),
  data: z.record(z.unknown()),
}).passthrough();

export type PaddleWebhookEvent = z.infer<typeof paddleEventSchema>;

function signatureParts(header: string): { timestamp: number; signatures: string[] } {
  const values = new Map<string, string[]>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!value) continue;
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const rawTimestamp = values.get("ts")?.[0];
  const signatures = values.get("h1") ?? [];
  if (!rawTimestamp || !/^\d+$/.test(rawTimestamp) || signatures.length === 0) {
    throw new AppError("paddle_signature_invalid", "Paddle signature header is malformed");
  }
  const timestamp = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestamp)) {
    throw new AppError("paddle_signature_invalid", "Paddle signature timestamp is invalid");
  }
  return { timestamp, signatures };
}

/** Verifies the unmodified request body using Paddle's `ts:rawBody` HMAC-SHA256 scheme. */
export function verifyPaddleWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}): void {
  if (!input.secret) throw new AppError("paddle_webhook_unconfigured", "Paddle webhook secret is not configured");
  const { timestamp, signatures } = signatureParts(input.signatureHeader);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const tolerance = input.toleranceSeconds ?? 5;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || Math.abs(nowSeconds - timestamp) > tolerance) {
    throw new AppError("paddle_signature_expired", "Paddle webhook signature is outside the accepted time window");
  }

  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}:${input.rawBody}`, "utf8")
    .digest();
  const matches = signatures.some((candidate) => {
    if (!/^[a-f\d]{64}$/i.test(candidate)) return false;
    const actual = Buffer.from(candidate, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  if (!matches) throw new AppError("paddle_signature_invalid", "Paddle webhook signature does not match");
}

export function parsePaddleWebhook(rawBody: string): PaddleWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (cause) {
    throw new AppError("paddle_payload_invalid", "Paddle webhook body is not valid JSON", { cause });
  }
  const result = paddleEventSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError("paddle_payload_invalid", "Paddle webhook body is missing required event fields", {
      details: { issues: result.error.issues.map((issue) => ({ path: issue.path, code: issue.code })) },
    });
  }
  return result.data;
}

export type IngestPaddleWebhookResult = {
  duplicate: boolean;
  event: PaymentWebhookEventRow;
};

/**
 * Verifies before parsing, then durably deduplicates both Paddle's event and notification
 * identifiers. Processing happens asynchronously from this inbox in the next billing layer.
 */
export async function ingestPaddleWebhook(db: Db, input: {
  rawBody: string;
  signatureHeader: string;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}): Promise<IngestPaddleWebhookResult> {
  verifyPaddleWebhookSignature(input);
  const event = parsePaddleWebhook(input.rawBody);
  const payloadSha256 = createHash("sha256").update(input.rawBody, "utf8").digest("hex");

  return db.transaction(async (trx) => {
    const [inserted] = await trx.insert(paymentWebhookEvents).values({
      notificationId: event.notification_id,
      eventId: event.event_id,
      eventType: event.event_type,
      occurredAt: new Date(event.occurred_at),
      payloadSha256,
      payloadJson: event,
    }).onConflictDoNothing().returning();
    if (inserted) return { duplicate: false, event: inserted };

    const [existing] = await trx.select().from(paymentWebhookEvents).where(or(
      eq(paymentWebhookEvents.notificationId, event.notification_id),
      eq(paymentWebhookEvents.eventId, event.event_id),
    ));
    if (!existing || existing.payloadSha256 !== payloadSha256) {
      throw new AppError("paddle_event_conflict", "Paddle event identifier was reused with a different payload");
    }
    return { duplicate: true, event: existing };
  });
}
