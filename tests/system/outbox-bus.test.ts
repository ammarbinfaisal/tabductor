import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  DEAD_LETTER_TYPE,
  createDispatcher,
  claim,
  publish,
  type Dispatcher,
} from "@tabductor/bus";
import { events, outbox, type EventRow } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";

let handle: MigratedTestDb;
const running: Dispatcher[] = [];

beforeAll(async () => {
  handle = await createMigratedTestDb();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((d) => d.stop()));
  // Each test owns the whole DB; clearing events cascades to outbox.
  await handle.db.delete(events);
});

afterAll(async () => {
  await handle?.close();
});

/** Dispatcher with test-fast timings, auto-stopped after the test. */
function startDispatcher(opts: Parameters<typeof createDispatcher>[1] = {}): Dispatcher {
  const dispatcher = createDispatcher(handle, { intervalMs: 50, backoffBaseMs: 10, ...opts });
  running.push(dispatcher);
  return dispatcher;
}

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

it("a rolled-back transaction publishes nothing and delivers nothing", async () => {
  const delivered: EventRow[] = [];
  const dispatcher = startDispatcher();
  dispatcher.subscribe((e) => void delivered.push(e));
  await dispatcher.start();

  await expect(
    handle.db.transaction(async (trx) => {
      await publish(trx, { type: "test.rolled_back", packet: { n: 1 } });
      throw new Error("domain write failed");
    }),
  ).rejects.toThrow("domain write failed");

  // Give the dispatcher several poll intervals to (not) find anything.
  await new Promise((r) => setTimeout(r, 300));

  expect(await handle.db.select().from(events)).toHaveLength(0);
  expect(await handle.db.select().from(outbox)).toHaveLength(0);
  expect(delivered).toHaveLength(0);
});

it("a committed transaction delivers exactly once and marks the row dispatched", async () => {
  const delivered: EventRow[] = [];
  const dispatcher = startDispatcher();
  dispatcher.subscribe((e) => void delivered.push(e));
  await dispatcher.start();

  const published = await handle.db.transaction((trx) =>
    publish(trx, { type: "test.committed", packet: { hello: "world" } }),
  );

  await waitFor("delivery", () => delivered.length > 0);
  await new Promise((r) => setTimeout(r, 200)); // prove it is not delivered again

  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.eventId).toBe(published.eventId);
  expect(delivered[0]!.packet).toEqual({ hello: "world" });

  const [row] = await handle.db.select().from(outbox).where(eq(outbox.eventId, published.eventId));
  expect(row!.status).toBe("dispatched");
  expect(row!.dispatchedAt).not.toBeNull();
  expect(row!.attempts).toBe(0);
});

it("redelivery calls the handler twice; claim admits the event once", async () => {
  const taskId = "task_dedupe";
  const seen: string[] = [];
  const claims: string[] = [];
  const dispatcher = startDispatcher();
  dispatcher.subscribe(async (e) => {
    seen.push(e.eventId);
    claims.push(await claim(handle.db, taskId, e.eventId));
  });
  await dispatcher.start();

  const event = await handle.db.transaction((trx) => publish(trx, { type: "test.redelivered" }));
  await waitFor("first delivery", () => seen.length === 1);

  // Force at-least-once redelivery the way a crashed dispatcher would.
  await handle.db
    .update(outbox)
    .set({ status: "pending", dispatchedAt: null })
    .where(eq(outbox.eventId, event.eventId));

  await waitFor("redelivery", () => seen.length === 2);
  expect(seen).toEqual([event.eventId, event.eventId]);
  expect(claims).toEqual(["claimed", "duplicate"]);
});

it("dead-letters after max attempts and publishes system.event_dead_lettered", async () => {
  let calls = 0;
  const dispatcher = startDispatcher({ maxAttempts: 3 });
  dispatcher.subscribe((e) => {
    if (e.type !== "test.poison") return; // the dead-letter notice must go through fine
    calls++;
    throw new Error("subscriber exploded");
  });
  await dispatcher.start();

  const poison = await handle.db.transaction((trx) => publish(trx, { type: "test.poison" }));

  await waitFor("dead-letter", async () => {
    const [row] = await handle.db.select().from(outbox).where(eq(outbox.eventId, poison.eventId));
    return row?.status === "dead_letter";
  });

  const [row] = await handle.db.select().from(outbox).where(eq(outbox.eventId, poison.eventId));
  expect(row!.attempts).toBe(3);
  expect(row!.lastError).toContain("subscriber exploded");
  expect(calls).toBe(3);

  await waitFor("dead-letter notice dispatched", async () => {
    const [notice] = await handle.db.select().from(events).where(eq(events.type, DEAD_LETTER_TYPE));
    if (!notice) return false;
    const [noticeRow] = await handle.db
      .select()
      .from(outbox)
      .where(eq(outbox.eventId, notice.eventId));
    return noticeRow?.status === "dispatched";
  });

  const [notice] = await handle.db.select().from(events).where(eq(events.type, DEAD_LETTER_TYPE));
  expect(notice!.causationId).toBe(poison.eventId);
  expect(notice!.packet).toMatchObject({ eventId: poison.eventId, type: "test.poison", attempts: 3 });

  // Guard against recursive dead-lettering: exactly one notice, and it is not itself poison.
  expect(await handle.db.select().from(events).where(eq(events.type, DEAD_LETTER_TYPE))).toHaveLength(1);
});

it("broadcasts every event to every subscriber", async () => {
  const a: string[] = [];
  const b: string[] = [];
  const dispatcher = startDispatcher();
  dispatcher.subscribe((e) => void a.push(e.type));
  dispatcher.subscribe((e) => void b.push(e.type));
  await dispatcher.start();

  await handle.db.transaction(async (trx) => {
    await publish(trx, { type: "test.one" });
    await publish(trx, { type: "test.two" });
  });

  await waitFor("both subscribers", () => a.length === 2 && b.length === 2);
  expect(a.sort()).toEqual(["test.one", "test.two"]);
  expect(b.sort()).toEqual(["test.one", "test.two"]);
});

it("stop() drains in-flight delivery before returning", async () => {
  let finished = 0;
  const dispatcher = startDispatcher();
  dispatcher.subscribe(async () => {
    await new Promise((r) => setTimeout(r, 200));
    finished++;
  });
  await dispatcher.start();

  await handle.db.transaction((trx) => publish(trx, { type: "test.slow" }));
  await waitFor("delivery to start", async () => {
    const [row] = await handle.db.select().from(outbox);
    return row !== undefined;
  });
  await new Promise((r) => setTimeout(r, 100)); // let the batch get picked up

  await dispatcher.stop();
  expect(finished).toBe(1);
  const [row] = await handle.db.select().from(outbox);
  expect(row!.status).toBe("dispatched");
});
