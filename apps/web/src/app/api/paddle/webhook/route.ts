import { AppError, loadConfig } from "@tabductor/core";
import { ingestPaddleWebhook, parsePaddleCreditPacks, processPaddleWebhookEvent } from "@tabductor/engine";
import { NextResponse } from "next/server";
import { db } from "../../../../server/db.js";

export async function POST(request: Request) {
  const config = loadConfig(process.env);
  if (!config.PADDLE_WEBHOOK_SECRET || !config.PADDLE_CREDIT_PACKS_JSON) {
    return NextResponse.json({ error: "billing webhook is not configured" }, { status: 503 });
  }
  const signatureHeader = request.headers.get("paddle-signature");
  if (!signatureHeader) {
    return NextResponse.json({ error: "invalid webhook" }, { status: 401 });
  }

  try {
    const result = await ingestPaddleWebhook(db(), {
      rawBody: await request.text(),
      signatureHeader,
      secret: config.PADDLE_WEBHOOK_SECRET,
    });
    const status = await processPaddleWebhookEvent(
      db(),
      result.event.notificationId,
      parsePaddleCreditPacks(config.PADDLE_CREDIT_PACKS_JSON),
    );
    return NextResponse.json({ accepted: true, duplicate: result.duplicate, status });
  } catch (error) {
    // Signature and payload errors intentionally have the same public response.
    if (error instanceof AppError && [
      "paddle_signature_invalid",
      "paddle_signature_expired",
      "paddle_payload_invalid",
      "paddle_event_conflict",
    ].includes(error.code)) {
      return NextResponse.json({ error: "invalid webhook" }, { status: 401 });
    }
    return NextResponse.json({ error: "webhook processing failed" }, { status: 500 });
  }
}
