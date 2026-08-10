/**
 * A token bucket, in process (S2d, sharing.md §5.3).
 *
 * The public read path is the only surface in the system that runs queries for an
 * unauthenticated caller, so it needs a ceiling. This one is deliberately small: a Map, a
 * timestamp and no dependency.
 *
 * **It is per-instance, and that is the honest limit.** One control-plane process is the
 * deployment today; when it is replicated this becomes a shared counter, and Postgres is
 * where that goes — a rate limiter is not a reason to take a Redis dependency the design
 * doc turned down for the event bus (§6).
 */

export type RateLimiter = { take: (key: string) => boolean };

type Bucket = { tokens: number; at: number };

export function createRateLimiter(options: {
  /** Burst size, and the starting balance for a key nobody has seen. */
  capacity: number;
  refillPerSecond: number;
  /** Bound on memory: the oldest keys are dropped past this, which only grants tokens back. */
  maxKeys?: number;
}): RateLimiter {
  const { capacity, refillPerSecond, maxKeys = 10_000 } = options;
  const buckets = new Map<string, Bucket>();

  return {
    take(key) {
      const now = Date.now();
      const bucket = buckets.get(key) ?? { tokens: capacity, at: now };
      const refilled = Math.min(capacity, bucket.tokens + ((now - bucket.at) / 1000) * refillPerSecond);

      if (refilled < 1) {
        // Keep `at` moving so the next call still accrues; do not reset the balance.
        buckets.set(key, { tokens: refilled, at: now });
        return false;
      }

      buckets.set(key, { tokens: refilled - 1, at: now });
      if (buckets.size > maxKeys) {
        // Map preserves insertion order, so the first key is the least recently created.
        // Eviction can only hand someone a fresh bucket, never a smaller one, so a hostile
        // caller cannot use it to evict a victim into a penalty.
        const oldest = buckets.keys().next();
        if (!oldest.done && oldest.value !== key) buckets.delete(oldest.value);
      }
      return true;
    },
  };
}
