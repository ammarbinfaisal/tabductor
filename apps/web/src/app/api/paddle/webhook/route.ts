import { loadConfig } from "@tabductor/core";
import { ingestPaddleWebhook } from "@tabductor/engine";
import { NextResponse } from "next/server";
import { db } from "../../../../server/db.js";

export async function POST(request: Request) {
  const config = loadConfig(process.env);
  if (!config.PADDLE_WEBHOOK_SECRET) {
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
    return NextResponse.json({ accepted: true, duplicate: result.duplicate });
  } catch {
    // Signature and payload errors intentionally have the same public response.
    return NextResponse.json({ error: "invalid webhook" }, { status: 401 });
  }
}
