import { afterAll, beforeAll, expect, it } from "vitest";
import { chainDepth, publish } from "@tabductor/bus";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";

let handle: MigratedTestDb;

beforeAll(async () => {
  handle = await createMigratedTestDb();
});

afterAll(async () => {
  await handle?.close();
});

/** Returns the event ids of a chain of length `depth`, root first. */
async function buildChain(depth: number): Promise<string[]> {
  return handle.db.transaction(async (trx) => {
    const ids: string[] = [];
    let causationId: string | null = null;
    for (let i = 0; i < depth; i++) {
      const event = await publish(trx, { type: "test.hop", packet: { i }, causationId });
      causationId = event.eventId;
      ids.push(event.eventId);
    }
    return ids;
  });
}

it("computes causation chain depth and respects the cap", async () => {
  const ids = await buildChain(50);

  expect(await chainDepth(handle.db, ids[0]!)).toBe(1);
  expect(await chainDepth(handle.db, ids[9]!)).toBe(10);
  expect(await chainDepth(handle.db, ids[49]!)).toBe(50);

  // Cap truncates the walk rather than failing.
  expect(await chainDepth(handle.db, ids[49]!, 10)).toBe(10);
  expect(await chainDepth(handle.db, ids[49]!, 1)).toBe(1);
});

it("returns 0 for an unknown event and 1 for a root event", async () => {
  const [root] = await buildChain(1);
  expect(await chainDepth(handle.db, root!)).toBe(1);
  expect(await chainDepth(handle.db, "00000000-0000-4000-8000-000000000000")).toBe(0);
});
