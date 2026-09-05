import { publish } from "@tabductor/bus";
import { AppError, createLogger, type Logger } from "@tabductor/core";
import { cdpEndpoints, endpointLeases, runs, type Db } from "@tabductor/db";
import type { Metrics } from "@tabductor/telemetry";
import { and, eq, sql } from "drizzle-orm";
import { resolveCdpWsUrl } from "./cdp-url.js";
import type { BrowserConn, Driver } from "./driver.js";

/**
 * The endpoint pool (§8, §15): one `BrowserConn` per CDP endpoint, connected lazily on
 * first `acquire`, health-checked, and serialized behind a DB-backed lease so at most one
 * run drives an endpoint at a time — across engine restarts, since the lease is a row this
 * process did not have to be alive to write.
 *
 * No queue library (S3b style constraint): `endpoint_leases` is the queue's durable state
 * and the per-endpoint `waiters` array below is the only in-process bookkeeping. Neither is
 * generic enough to reuse for anything but this one job, which is the point.
 *
 * Deviation from the subphase doc: it names the ping `Browser.getVersion` via a driver
 * `ping()`. `BrowserConn.version()` already **is** `Browser.getVersion` (see driver.ts), so
 * this file calls that instead of adding a same-shaped second method.
 */

export type EndpointPoolDeps = {
  db: Db;
  driver: Driver;
  /** Injected, exactly like `PolicyGate` (§17.2 rule 1). Absent means uninstrumented. */
  metrics?: Metrics;
  logger?: Logger;
  /** Ping interval for endpoints the pool currently holds a live connection to. */
  healthCheckMs?: number;
  /** How often a held lease's `heartbeat_at` is refreshed while it is held. */
  heartbeatMs?: number;
  /** A lease whose heartbeat is older than this is reapable by the next claimant. */
  leaseStaleMs?: number;
  /** Reconnect backoff = base * 2^attempt, capped at max. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
};

export type EndpointLease = { conn: BrowserConn; release: () => Promise<void> };

export type EndpointPool = {
  acquire: (endpointId: string, runId: string) => Promise<EndpointLease>;
  close: () => Promise<void>;
};

const DEFAULTS = {
  healthCheckMs: 5_000,
  heartbeatMs: 2_000,
  leaseStaleMs: 15_000,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
};

/** A queued `acquire` that lost the immediate claim. Ordering is by run creation time
 * (§15 "FIFO by run creation"), not by arrival at this function — two runs racing to
 * `acquire` must still serve the older run first. `seq` breaks ties within one millisecond. */
type Waiter = {
  runId: string;
  createdAtMs: number;
  seq: number;
  waitStartedMs: number;
  settle: (lease: EndpointLease) => void;
  fail: (err: unknown) => void;
};

type EndpointState = {
  /** True from the moment a live connection is known dead until a reconnect succeeds. */
  dead: boolean;
  conn?: BrowserConn;
  connecting?: Promise<BrowserConn>;
  backoffAttempt: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Last value written to `cdp_endpoints.healthy`, so writes happen only on transition —
   * "health transitions are DB writes," not a write per ping. */
  dbHealthy: boolean;
  waiters: Waiter[];
  heldRunId?: string;
  heartbeatTimer?: ReturnType<typeof setInterval>;
};

let waiterSeq = 0;

export function createEndpointPool(deps: EndpointPoolDeps): EndpointPool {
  const { db, driver } = deps;
  const metrics = deps.metrics;
  const log = deps.logger ?? createLogger({ name: "browser-pool" });
  const healthCheckMs = deps.healthCheckMs ?? DEFAULTS.healthCheckMs;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULTS.heartbeatMs;
  const leaseStaleMs = deps.leaseStaleMs ?? DEFAULTS.leaseStaleMs;
  const backoffBaseMs = deps.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
  const backoffMaxMs = deps.backoffMaxMs ?? DEFAULTS.backoffMaxMs;

  const states = new Map<string, EndpointState>();
  let closed = false;

  const stateOf = (endpointId: string): EndpointState => {
    let s = states.get(endpointId);
    if (!s) {
      s = { dead: false, backoffAttempt: 0, dbHealthy: true, waiters: [] };
      states.set(endpointId, s);
    }
    return s;
  };

  // Sampled on collection, like `observeOutboxDepth` — `cdp_endpoints.healthy` is already
  // the state, so the callback reads it rather than the pool duplicating a gauge of its own.
  metrics?.observeBrowserEndpointHealthy(async () => {
    const rows = await db.select({ id: cdpEndpoints.id, healthy: cdpEndpoints.healthy }).from(cdpEndpoints);
    return rows.map((r) => ({ endpointId: r.id, healthy: r.healthy }));
  });

  const setHealthy = async (endpointId: string, healthy: boolean): Promise<void> => {
    const s = stateOf(endpointId);
    if (s.dbHealthy === healthy) return;
    s.dbHealthy = healthy;
    await db
      .update(cdpEndpoints)
      .set({ healthy, lastCheckedAt: sql`now()` })
      .where(eq(cdpEndpoints.id, endpointId));
  };

  const getEndpointRow = async (
    endpointId: string,
  ): Promise<{ wsUrl: string; maxQueueDepth: number }> => {
    const [row] = await db
      .select({ wsUrl: cdpEndpoints.wsUrl, maxQueueDepth: cdpEndpoints.maxQueueDepth })
      .from(cdpEndpoints)
      .where(eq(cdpEndpoints.id, endpointId));
    if (!row) {
      throw new AppError("endpoint_not_found", `no cdp endpoint ${endpointId}`, { details: { endpointId } });
    }
    return row;
  };

  /** The wrapped conn is what `acquire` hands out. Once the endpoint is marked dead, every
   * call fails typed and immediately — the lease holder's *next* driver call is how it
   * "finds out," rather than polling pool state of its own. */
  const wrap = (raw: BrowserConn, endpointId: string): BrowserConn => {
    const disconnectedErr = (): AppError =>
      new AppError("browser.disconnected", `endpoint ${endpointId} disconnected`, {
        details: { endpointId },
      });
    raw.onDisconnect?.(() => handleDisconnect(endpointId));
    return {
      createPage: (opts) =>
        stateOf(endpointId).dead ? Promise.reject(disconnectedErr()) : raw.createPage(opts),
      version: () => (stateOf(endpointId).dead ? Promise.reject(disconnectedErr()) : raw.version()),
      close: () => raw.close(),
    };
  };

  /** Connects if nobody is currently connecting; concurrent callers share the one attempt.
   * On failure the endpoint is left dead and a reconnect is scheduled — an `acquire` that
   * hit this failure still surfaces it (see `grantLease`), it just does not have to be the
   * thing that retries. */
  const ensureConnected = (endpointId: string): Promise<BrowserConn> => {
    const s = stateOf(endpointId);
    if (s.conn && !s.dead) return Promise.resolve(s.conn);
    if (s.connecting) return s.connecting;

    s.connecting = (async () => {
      try {
        const row = await getEndpointRow(endpointId);
        // Resolved per connect, not per add: the DevTools GUID changes on every browser
        // restart, so a `ws://` URL frozen at add time names a target that stops existing
        // the first time the user quits Chrome. An endpoint stored as `http://host:port`
        // re-discovers it here and simply keeps working. A stored `ws://` passes through.
        const wsUrl = await resolveCdpWsUrl(row.wsUrl);
        const raw = await driver.connect(wsUrl);
        const conn = wrap(raw, endpointId);
        s.conn = conn;
        s.dead = false;
        s.backoffAttempt = 0;
        if (s.reconnectTimer) {
          clearTimeout(s.reconnectTimer);
          s.reconnectTimer = undefined;
        }
        await setHealthy(endpointId, true);
        return conn;
      } catch (err) {
        // Logged here because this is the only frame that still holds *why*. `grantLease`
        // turns whatever lands here into `browser.disconnected` for the run, and
        // `scheduleReconnect` swallows its retries entirely — so without this line an
        // unreachable endpoint produces a run that failed for a generic reason and an engine
        // log that says nothing at all, which is exactly how long a network-level
        // misconfiguration can hide.
        log.warn("cdp endpoint connect failed", {
          endpointId,
          error: err instanceof AppError ? err.code : String(err),
          detail: err instanceof Error ? err.message : undefined,
        });
        s.dead = true;
        await setHealthy(endpointId, false).catch(() => undefined);
        scheduleReconnect(endpointId);
        throw err;
      }
    })();
    return s.connecting.finally(() => {
      s.connecting = undefined;
    });
  };

  const scheduleReconnect = (endpointId: string): void => {
    if (closed) return;
    const s = stateOf(endpointId);
    if (s.reconnectTimer) return;
    const delay = Math.min(backoffBaseMs * 2 ** s.backoffAttempt, backoffMaxMs);
    s.reconnectTimer = setTimeout(() => {
      s.reconnectTimer = undefined;
      ensureConnected(endpointId).catch(() => {
        s.backoffAttempt += 1;
        scheduleReconnect(endpointId);
      });
    }, delay);
  };

  /** A live connection just died — driver callback or a failed ping, either reaches here.
   * Idempotent: both can fire for the same episode, and only the first must record it.
   * The `closed` check is not redundancy: Playwright fires `disconnected` for our own
   * graceful `browser.close()` too, and `close()` below flips `closed` before closing any
   * conn — without the check, every intentional shutdown would publish a spurious
   * `browser.disconnected` event and write `healthy=false` for endpoints that are fine. */
  const handleDisconnect = (endpointId: string): void => {
    if (closed) return;
    const s = stateOf(endpointId);
    if (s.dead) return;
    s.dead = true;
    s.conn = undefined;
    metrics?.browserDisconnects.add({ endpointId });

    void db
      .transaction(async (trx) => {
        await trx
          .update(cdpEndpoints)
          .set({ healthy: false, lastCheckedAt: sql`now()` })
          .where(eq(cdpEndpoints.id, endpointId));
        const [lease] = await trx
          .select()
          .from(endpointLeases)
          .where(eq(endpointLeases.endpointId, endpointId));
        // Endpoint id and run id are all a subscriber needs; the ws_url never appears in a
        // telemetry or event payload (§16 Threat 5). `runId` is null when nobody was
        // holding the lease at the moment of the drop — an idle endpoint going down is
        // still worth telling the world about.
        await publish(trx, {
          type: "browser.disconnected",
          sourceRunId: lease?.runId ?? null,
          packet: { endpointId, runId: lease?.runId ?? null },
        });
      })
      .then(() => {
        s.dbHealthy = false;
      })
      .catch((err) => log.error("failed to record disconnect", { endpointId, error: String(err) }));

    scheduleReconnect(endpointId);
  };

  /** The atomic claim: succeeds when the endpoint has no lease, or its lease's heartbeat is
   * older than `leaseStaleMs`. The reap and the fresh claim are the same statement — a
   * conditional `ON CONFLICT DO UPDATE ... WHERE` — so nothing here can race a concurrent
   * claimant, in this process or another engine instance entirely. */
  const tryClaimLease = async (endpointId: string, runId: string): Promise<boolean> => {
    const rows = await db
      .insert(endpointLeases)
      .values({ endpointId, runId, heartbeatAt: sql`now()` })
      .onConflictDoUpdate({
        target: endpointLeases.endpointId,
        set: { runId, heartbeatAt: sql`now()` },
        where: sql`${endpointLeases.heartbeatAt} < now() - ${`${leaseStaleMs} milliseconds`}::interval`,
      })
      .returning({ endpointId: endpointLeases.endpointId });
    return rows.length > 0;
  };

  const teardownLease = async (endpointId: string, runId: string): Promise<void> => {
    const s = stateOf(endpointId);
    if (s.heartbeatTimer) {
      clearInterval(s.heartbeatTimer);
      s.heartbeatTimer = undefined;
    }
    if (s.heldRunId === runId) s.heldRunId = undefined;
    await db
      .delete(endpointLeases)
      .where(and(eq(endpointLeases.endpointId, endpointId), eq(endpointLeases.runId, runId)));
  };

  const startHeartbeat = (endpointId: string, runId: string): ReturnType<typeof setInterval> =>
    setInterval(() => {
      void db
        .update(endpointLeases)
        .set({ heartbeatAt: sql`now()` })
        .where(and(eq(endpointLeases.endpointId, endpointId), eq(endpointLeases.runId, runId)))
        .catch((err) => log.warn("lease heartbeat failed", { endpointId, runId, error: String(err) }));
    }, heartbeatMs);

  /** Turns a won claim into a handed-out lease: starts the heartbeat, connects (lazily),
   * and records the queue wait — win-by-immediate-claim and win-by-handoff both funnel
   * through here so the metric and the heartbeat start exactly once per grant. */
  const grantLease = async (endpointId: string, runId: string, waitStartedMs: number): Promise<EndpointLease> => {
    const s = stateOf(endpointId);
    s.heldRunId = runId;
    s.heartbeatTimer = startHeartbeat(endpointId, runId);
    metrics?.browserQueueWait.record((Date.now() - waitStartedMs) / 1000, { endpointId });

    let conn: BrowserConn;
    try {
      conn = await ensureConnected(endpointId);
    } catch (err) {
      await teardownLease(endpointId, runId);
      handoff(endpointId);
      throw err instanceof AppError
        ? err
        : new AppError("browser.disconnected", `could not connect to endpoint ${endpointId}`, {
            cause: err,
            details: { endpointId },
          });
    }

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await teardownLease(endpointId, runId);
      handoff(endpointId);
    };
    return { conn, release };
  };

  /** Wakes the next FIFO waiter, if any, once a lease frees up. Known limitation, never
   * exercised by a single-process pool: if a claim lost to a claimant outside this pool's
   * own queue (another engine instance), the waiter is put back to wait for the *next*
   * release rather than retried in a loop here — cross-process fairness is not this file's
   * job, only cross-process safety (the atomic claim) is. */
  const handoff = (endpointId: string): void => {
    const s = stateOf(endpointId);
    const next = s.waiters.shift();
    if (!next) return;
    void tryClaimLease(endpointId, next.runId)
      .then((claimed) => {
        if (!claimed) {
          s.waiters.unshift(next);
          return;
        }
        return grantLease(endpointId, next.runId, next.waitStartedMs).then(next.settle, next.fail);
      })
      .catch(next.fail);
  };

  const runCreatedAtMs = async (runId: string): Promise<number> => {
    const [row] = await db.select({ createdAt: runs.createdAt }).from(runs).where(eq(runs.id, runId));
    // Callers that pass a runId with no backing row (a unit test, say) still get FIFO
    // ordering — by arrival, since "creation time" is undefined for them.
    return row ? row.createdAt.getTime() : Date.now();
  };

  const acquire = async (endpointId: string, runId: string): Promise<EndpointLease> => {
    if (closed) throw new AppError("pool_closed", "endpoint pool is closed");
    const waitStartedMs = Date.now();

    if (await tryClaimLease(endpointId, runId)) {
      return grantLease(endpointId, runId, waitStartedMs);
    }

    const s = stateOf(endpointId);
    const { maxQueueDepth } = await getEndpointRow(endpointId);
    if (s.waiters.length >= maxQueueDepth) {
      metrics?.browserQueueRejected.add({ endpointId });
      throw new AppError("endpoint_queue_full", `endpoint ${endpointId}'s queue is full`, {
        details: { endpointId, maxQueueDepth },
      });
    }

    const createdAtMs = await runCreatedAtMs(runId);
    return new Promise<EndpointLease>((settle, fail) => {
      s.waiters.push({ runId, createdAtMs, seq: waiterSeq++, waitStartedMs, settle, fail });
      s.waiters.sort((a, b) => a.createdAtMs - b.createdAtMs || a.seq - b.seq);
    });
  };

  const healthTimer = setInterval(() => {
    for (const [endpointId, s] of states) {
      if (!s.conn || s.dead) continue;
      s.conn.version().then(
        () => void setHealthy(endpointId, true).catch(() => undefined),
        () => handleDisconnect(endpointId),
      );
    }
  }, healthCheckMs);

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(healthTimer);
    for (const [, s] of states) {
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
      if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
      for (const waiter of s.waiters) {
        waiter.fail(new AppError("pool_closed", "endpoint pool closed while a run was queued"));
      }
      s.waiters = [];
      if (s.conn) await s.conn.close().catch(() => undefined);
    }
  };

  return { acquire, close };
}
