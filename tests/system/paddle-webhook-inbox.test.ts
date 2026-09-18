import { createHmac } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { paymentWebhookEvents } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { ingestPaddleWebhook } from "@tabductor/engine";

let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });

const secret = "pdl_ntfset_inbox_secret";
const now = new Date("2026-09-18T05:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);

function delivery(overrides: Record<string, unknown> = {}) {
  const rawBody = JSON.stringify({
    event_id: "evt_inbox_1",
    event_type: "transaction.completed",
    occurred_at: now.toISOString(),
    notification_id: "ntf_inbox_1",
    data: { id: "txn_inbox_1", status: "completed" },
    ...overrides,
  });
  const h1 = createHmac("sha256", secret).update(`${timestamp}:${rawBody}`, "utf8").digest("hex");
  return { rawBody, signatureHeader: `ts=${timestamp};h1=${h1}`, secret, now };
}

it("durably accepts a verified delivery exactly once", async () => {
  const first = await ingestPaddleWebhook(handle.db, delivery());
  expect(first).toMatchObject({ duplicate: false, event: { status: "received", attempts: 0 } });

  const repeated = await ingestPaddleWebhook(handle.db, delivery());
  expect(repeated).toMatchObject({ duplicate: true, event: { notificationId: "ntf_inbox_1" } });
  expect(await handle.db.select().from(paymentWebhookEvents)).toHaveLength(1);
});

it("rejects identifier reuse with a different signed payload", async () => {
  await expect(ingestPaddleWebhook(handle.db, delivery({
    notification_id: "ntf_inbox_changed",
    data: { id: "txn_inbox_1", status: "canceled" },
  }))).rejects.toMatchObject({ code: "paddle_event_conflict" });
});

it("does not persist invalid signatures", async () => {
  const input = delivery({ event_id: "evt_invalid", notification_id: "ntf_invalid" });
  await expect(ingestPaddleWebhook(handle.db, {
    ...input,
    signatureHeader: `ts=${timestamp};h1=${"0".repeat(64)}`,
  })).rejects.toMatchObject({ code: "paddle_signature_invalid" });
  expect((await handle.db.select().from(paymentWebhookEvents)).map((event) => event.eventId))
    .not.toContain("evt_invalid");
});
