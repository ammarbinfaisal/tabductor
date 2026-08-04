import { randomUUID } from "node:crypto";
import { createLogger, type Logger } from "@tabductor/core";
import { events, outbox, type Db, type EventRow } from "@tabductor/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type pg from "pg";

/** Postgres NOTIFY channel the dispatcher latches onto. */
export const NOTIFY_CHANNEL = "tabductor_outbox";

export const DEAD_LETTER_TYPE = "system.event_dead_lettered";

export type PublishInput = {
  type: string;
  packet?: unknown;
  eventId?: string;
  sourceTaskId?: string | null;
  sourceRunId?: string | null;
  causationId?: string | null;
  occurredAt?: Date;
};

/**
 * Transactional outbox: the event row and its outbox row are written with whatever
 * transaction handle the caller passes, so domain writes and their events commit together
 * or not at all. Nothing is delivered from here — the dispatcher drains the outbox.
 *
 * The wake-up NOTIFY is deliberately NOT sent here. `pg_notify` inside a transaction is
 * held until commit by Postgres itself, which is exactly the post-commit semantics we
 * want; a `notify` trigger on `outbox` gives us that for free (see migration), including
 * for writes that never go through this function.
 */
export async function publish(trx: Db, input: PublishInput): Promise<EventRow> {
  const [row] = await trx
    .insert(events)
    .values({
      eventId: input.eventId ?? randomUUID(),
      type: input.type,
      sourceTaskId: input.sourceTaskId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      causationId: input.causationId ?? null,
      packet: input.packet ?? {},
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    })
    .returning();
  const event = row!;
  await trx.insert(outbox).values({ eventId: event.eventId });
  return event;
}

export type Subscriber = (event: EventRow) => void | Promise<void>;

export type DispatcherOptions = {
  /** Rows claimed per poll. */
  batchSize?: number;
  /** Poll floor; NOTIFY wakes the loop sooner. */
  intervalMs?: number;
  maxAttempts?: number;
  /** Backoff = base * 2^(attempts-1), capped. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  logger?: Logger;
};

export type Dispatcher = {
  subscribe: (handler: Subscriber) => () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Drains until no row is ready; returns rows delivered. Test/priming aid. */
  drain: () => Promise<number>;
};

/**
 * Polling dispatcher with a LISTEN/NOTIFY wake-up latch.
 *
 * Broadcast: every subscriber receives every event and filters by type itself. A subscriber
 * that throws leaves the row `pending` with `attempts+1` and an exponential
 * `next_attempt_at`; past `maxAttempts` the row goes `dead_letter` and a
 * `system.event_dead_lettered` event is published (never for a dead-letter event itself,
 * which would recurse).
 */
export function createDispatcher(handle: { db: Db; pool: pg.Pool }, opts: DispatcherOptions = {}): Dispatcher {
  const { db, pool } = handle;
  const batchSize = opts.batchSize ?? 100;
  const intervalMs = opts.intervalMs ?? 250;
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoffBaseMs = opts.backoffBaseMs ?? 100;
  const backoffMaxMs = opts.backoffMaxMs ?? 30_000;
  const log = opts.logger ?? createLogger({ name: "bus" });

  const subscribers = new Set<Subscriber>();
  let running = false;
  let loop: Promise<void> | undefined;
  let listener: pg.PoolClient | undefined;
  let wake: (() => void) | undefined;

  const notify = (): void => wake?.();

  /** Sleeps up to `ms`, cut short by NOTIFY or by stop(). */
  const waitForWork = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      wake = done;
      function done(): void {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
    });

  const backoffFor = (attempts: number): Date =>
    new Date(Date.now() + Math.min(backoffBaseMs * 2 ** (attempts - 1), backoffMaxMs));

  /**
   * One batch: claim ready rows with FOR UPDATE SKIP LOCKED (so concurrent dispatchers
   * never double-claim), deliver, and settle each row — all inside the claiming
   * transaction, which keeps the lock held for the duration of delivery.
   */
  const dispatchBatch = async (): Promise<number> => {
    return db.transaction(async (trx) => {
      const claimed = await trx
        .select({ id: outbox.id, attempts: outbox.attempts, event: events })
        .from(outbox)
        .innerJoin(events, eq(events.eventId, outbox.eventId))
        .where(and(eq(outbox.status, "pending"), lte(outbox.nextAttemptAt, sql`now()`)))
        .orderBy(asc(outbox.id))
        .limit(batchSize)
        .for("update", { of: outbox, skipLocked: true });

      for (const row of claimed) {
        const error = await deliver(row.event);
        if (!error) {
          await trx
            .update(outbox)
            .set({ status: "dispatched", dispatchedAt: sql`now()`, lastError: null })
            .where(eq(outbox.id, row.id));
          continue;
        }

        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempts >= maxAttempts) {
          await trx
            .update(outbox)
            .set({ status: "dead_letter", attempts, lastError: message })
            .where(eq(outbox.id, row.id));
          log.warn("event dead-lettered", { eventId: row.event.eventId, type: row.event.type, error: message });
          // Publishing the notice through the same trx keeps it atomic with the status
          // change. Guarded: a failing dead-letter notice must not spawn another.
          if (row.event.type !== DEAD_LETTER_TYPE) {
            await publish(trx, {
              type: DEAD_LETTER_TYPE,
              causationId: row.event.eventId,
              packet: { eventId: row.event.eventId, type: row.event.type, attempts, error: message },
            });
          }
        } else {
          await trx
            .update(outbox)
            .set({ attempts, nextAttemptAt: backoffFor(attempts), lastError: message })
            .where(eq(outbox.id, row.id));
        }
      }
      return claimed.length;
    });
  };

  /**
   * Broadcast to every subscriber; the first rejection decides the row's fate. Each call is
   * wrapped so a *synchronous* throw becomes a rejection — a bare `map(fn => fn(event))`
   * would let it escape before `allSettled` ever sees it, skipping all retry bookkeeping.
   */
  const deliver = async (event: EventRow): Promise<unknown> => {
    const results = await Promise.allSettled(
      [...subscribers].map(async (fn) => fn(event)),
    );
    return results.find((r) => r.status === "rejected")?.reason;
  };

  const drain = async (): Promise<number> => {
    let total = 0;
    for (;;) {
      const n = await dispatchBatch();
      total += n;
      if (n === 0) return total;
    }
  };

  const run = async (): Promise<void> => {
    while (running) {
      try {
        // A full batch means more is waiting; skip the sleep.
        if ((await dispatchBatch()) === batchSize) continue;
      } catch (err) {
        log.error("dispatch batch failed", { error: String(err) });
      }
      if (running) await waitForWork(intervalMs);
    }
  };

  return {
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },

    async start() {
      if (running) return;
      running = true;
      listener = await pool.connect();
      listener.on("notification", notify);
      listener.on("error", (err) => log.warn("listen connection error", { error: String(err) }));
      await listener.query(`LISTEN ${NOTIFY_CHANNEL}`);
      loop = run();
    },

    async stop() {
      if (!running) return;
      running = false;
      wake?.(); // cut the sleep short
      await loop; // drains in-flight delivery: run() only exits between batches
      loop = undefined;
      if (listener) {
        listener.removeListener("notification", notify);
        await listener.query(`UNLISTEN ${NOTIFY_CHANNEL}`).catch(() => {});
        listener.release();
        listener = undefined;
      }
    },

    drain,
  };
}
