import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parsePaddleWebhook, verifyPaddleWebhookSignature } from "./paddle-webhooks.js";

const secret = "pdl_ntfset_test_secret";
const now = new Date("2026-09-18T05:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);
const body = JSON.stringify({
  event_id: "evt_signature",
  event_type: "transaction.completed",
  occurred_at: now.toISOString(),
  notification_id: "ntf_signature",
  data: { id: "txn_signature" },
});
const signature = (payload = body, time = timestamp) => createHmac("sha256", secret)
  .update(`${time}:${payload}`, "utf8")
  .digest("hex");

describe("Paddle webhook verification", () => {
  it("accepts an exact raw body and any matching h1 during secret rotation", () => {
    expect(() => verifyPaddleWebhookSignature({
      rawBody: body,
      signatureHeader: `ts=${timestamp};h1=${"0".repeat(64)};h1=${signature()}`,
      secret,
      now,
    })).not.toThrow();
  });

  it("rejects transformed bodies, stale timestamps, and malformed signatures", () => {
    expect(() => verifyPaddleWebhookSignature({
      rawBody: `${body}\n`,
      signatureHeader: `ts=${timestamp};h1=${signature()}`,
      secret,
      now,
    })).toThrow(expect.objectContaining({ code: "paddle_signature_invalid" }));
    expect(() => verifyPaddleWebhookSignature({
      rawBody: body,
      signatureHeader: `ts=${timestamp - 6};h1=${signature(body, timestamp - 6)}`,
      secret,
      now,
    })).toThrow(expect.objectContaining({ code: "paddle_signature_expired" }));
    expect(() => verifyPaddleWebhookSignature({
      rawBody: body,
      signatureHeader: "bad-header",
      secret,
      now,
    })).toThrow(expect.objectContaining({ code: "paddle_signature_invalid" }));
  });

  it("parses only events with the common Paddle envelope", () => {
    expect(parsePaddleWebhook(body)).toMatchObject({
      event_id: "evt_signature",
      notification_id: "ntf_signature",
      data: { id: "txn_signature" },
    });
    expect(() => parsePaddleWebhook(JSON.stringify({ event_type: "transaction.completed" })))
      .toThrow(expect.objectContaining({ code: "paddle_payload_invalid" }));
  });
});
