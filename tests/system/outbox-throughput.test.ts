import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { createDispatcher } from "@tabductor/bus";
import { createMigratedTestDb, events, outbox, type MigratedTestDb } from "@tabductor/db";

const TOTAL = 10_000;
const BUDGET_MS = 60_000;

let handle: MigratedTestDb;

beforeAll(async () => {
  handle = await createMigratedTestDb();
});

afterAll(async () => {
  await handle?.close();
});

/**
 * Guards against accidental O(n^2) polling (impl-phases Phase 1). Publishing uses batched
 * inserts — the point of the test is dispatcher drain rate, not insert rate.
 */
it(`dispatches ${TOTAL} events in under ${BUDGET_MS / 1000}s`, async () => {
  const rows = Array.from({ length: TOTAL }, (_, i) => ({
    eventId: randomUUID(),
    type: "test.load",
    packet: { i },
  }));

  await handle.db.transaction(async (trx) => {
    for (let i = 0; i < rows.length; i += 1_000) {
      const chunk = rows.slice(i, i + 1_000);
      await trx.insert(events).values(chunk);
      await trx.insert(outbox).values(chunk.map((r) => ({ eventId: r.eventId })));
    }
  });

  let seen = 0;
  const dispatcher = createDispatcher(handle, { batchSize: 500, intervalMs: 50 });
  dispatcher.subscribe(() => {
    seen++;
  });

  const started = performance.now();
  await dispatcher.start();
  try {
    const deadline = Date.now() + BUDGET_MS;
    while (seen < TOTAL && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await dispatcher.stop();
  }
  const elapsedMs = performance.now() - started;

  expect(seen).toBe(TOTAL);
  expect(elapsedMs).toBeLessThan(BUDGET_MS);

  const [pending] = await handle.db
    .select({ n: count() })
    .from(outbox)
    .where(eq(outbox.status, "pending"));
  expect(pending!.n).toBe(0);

  console.log(
    `dispatched ${TOTAL} events in ${Math.round(elapsedMs)}ms (${Math.round(TOTAL / (elapsedMs / 1000))}/s)`,
  );
}, 120_000);
