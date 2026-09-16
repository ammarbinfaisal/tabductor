import { AppError, newId } from "@tabductor/core";
import {
  browserAllocationRequests,
  browserProfileLeases,
  browserProfiles,
  browserSessions,
  browserWorkers,
  type BrowserSessionRow,
  type Db,
} from "@tabductor/db";
import { and, eq, sql } from "drizzle-orm";

export type BrowserAdmission = {
  reserve: (input: { accountId: string; sessionId: string }) => Promise<void>;
};

export async function createBrowserProfile(
  db: Db,
  input: { accountId: string; name: string; fingerprint?: Record<string, unknown>; proxyRef?: string },
): Promise<string> {
  const id = newId("profile");
  await db.insert(browserProfiles).values({
    id,
    accountId: input.accountId,
    name: input.name,
    fingerprintJson: input.fingerprint ?? {},
    proxyRef: input.proxyRef ?? null,
  });
  return id;
}

/** Atomically owns a profile and queues one clean worker allocation. */
export async function requestBrowserSession(
  db: Db,
  input: { accountId: string; profileId: string; executionId?: string },
  admission?: BrowserAdmission,
): Promise<string> {
  const [profile] = await db.select({ id: browserProfiles.id }).from(browserProfiles).where(and(
    eq(browserProfiles.id, input.profileId),
    eq(browserProfiles.accountId, input.accountId),
  ));
  if (!profile) throw new AppError("browser_profile_not_found", "browser profile does not exist");

  const sessionId = newId("session");
  await admission?.reserve({ accountId: input.accountId, sessionId });
  await db.transaction(async (trx) => {
    await trx.insert(browserSessions).values({
      id: sessionId,
      accountId: input.accountId,
      profileId: input.profileId,
      executionId: input.executionId ?? null,
    });
    const lease = await trx.insert(browserProfileLeases).values({
      profileId: input.profileId,
      sessionId,
      generation: 1,
    }).onConflictDoNothing().returning({ profileId: browserProfileLeases.profileId });
    if (lease.length === 0) throw new AppError("browser_profile_busy", "browser profile is already in use");
    await trx.insert(browserAllocationRequests).values({
      id: newId("alloc"),
      accountId: input.accountId,
      sessionId,
    });
  });
  return sessionId;
}

export type ClaimedBrowserAllocation = {
  requestId: string;
  sessionId: string;
  accountId: string;
  profileId: string;
  generation: number;
};

/**
 * Claims the oldest per-account queue head, preferring accounts with fewer active sessions.
 * The status compare-and-set lets multiple controllers reconcile without assigning one request twice.
 */
export async function claimBrowserAllocation(db: Db): Promise<ClaimedBrowserAllocation | undefined> {
  return db.transaction(async (trx) => {
    const selected = await trx.execute<ClaimedBrowserAllocation>(sql`
      with heads as (
        select r.id as "requestId", r.session_id as "sessionId", r.account_id as "accountId",
               s.profile_id as "profileId", s.generation as "generation",
               row_number() over (partition by r.account_id order by r.created_at, r.id) as account_rank,
               (select count(*)::int from browser_sessions live
                 where live.account_id = r.account_id
                   and live.status in ('allocating','ready','running','stopping')) as active_count,
               r.created_at
        from browser_allocation_requests r
        join browser_sessions s on s.id = r.session_id
        where r.status = 'queued' and r.not_before <= now() and s.status = 'queued'
      )
      select "requestId", "sessionId", "accountId", "profileId", "generation"
      from heads where account_rank = 1
      order by active_count, created_at, "requestId"
      limit 1
    `);
    const candidate = selected.rows[0];
    if (!candidate) return undefined;
    const claimed = await trx.update(browserAllocationRequests).set({
      status: "claimed",
      claimedAt: sql`now()`,
      attempts: sql`${browserAllocationRequests.attempts} + 1`,
    }).where(and(
      eq(browserAllocationRequests.id, candidate.requestId),
      eq(browserAllocationRequests.status, "queued"),
    )).returning({ id: browserAllocationRequests.id });
    if (claimed.length === 0) return undefined;
    await trx.update(browserSessions).set({ status: "allocating" }).where(and(
      eq(browserSessions.id, candidate.sessionId),
      eq(browserSessions.status, "queued"),
    ));
    return candidate;
  });
}

export async function fulfillBrowserAllocation(
  db: Db,
  input: ClaimedBrowserAllocation & { workerId: string; podName: string },
): Promise<void> {
  await db.transaction(async (trx) => {
    await trx.insert(browserWorkers).values({
      id: input.workerId,
      podName: input.podName,
      status: "allocated",
      sessionId: input.sessionId,
      generation: input.generation,
    });
    const updated = await trx.update(browserSessions).set({
      status: "ready",
      workerId: input.workerId,
      podName: input.podName,
      readyAt: sql`now()`,
      heartbeatAt: sql`now()`,
    }).where(and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.status, "allocating"),
      eq(browserSessions.generation, input.generation),
    )).returning({ id: browserSessions.id });
    if (updated.length === 0) throw new AppError("browser_allocation_stale", "browser allocation lost ownership");
    await trx.update(browserAllocationRequests).set({ status: "fulfilled" })
      .where(eq(browserAllocationRequests.id, input.requestId));
  });
}

export async function failBrowserAllocation(
  db: Db,
  allocation: ClaimedBrowserAllocation,
  error: string,
  retry = true,
): Promise<void> {
  await db.transaction(async (trx) => {
    if (retry) {
      await trx.update(browserSessions).set({
        status: "queued",
        generation: sql`${browserSessions.generation} + 1`,
        error,
      }).where(and(eq(browserSessions.id, allocation.sessionId), eq(browserSessions.status, "allocating")));
      await trx.update(browserProfileLeases).set({
        generation: sql`${browserProfileLeases.generation} + 1`,
        heartbeatAt: sql`now()`,
      }).where(eq(browserProfileLeases.sessionId, allocation.sessionId));
      await trx.update(browserAllocationRequests).set({
        status: "queued",
        claimedAt: null,
        notBefore: sql`now() + interval '2 seconds'`,
      }).where(eq(browserAllocationRequests.id, allocation.requestId));
    } else {
      await trx.update(browserSessions).set({ status: "failed", endedAt: sql`now()`, error })
        .where(eq(browserSessions.id, allocation.sessionId));
      await trx.update(browserAllocationRequests).set({ status: "failed" })
        .where(eq(browserAllocationRequests.id, allocation.requestId));
      await trx.delete(browserProfileLeases).where(eq(browserProfileLeases.sessionId, allocation.sessionId));
    }
  });
}

export async function endBrowserSession(db: Db, sessionId: string): Promise<BrowserSessionRow | undefined> {
  return db.transaction(async (trx) => {
    const [ended] = await trx.update(browserSessions).set({ status: "ended", endedAt: sql`now()` })
      .where(and(eq(browserSessions.id, sessionId), sql`${browserSessions.status} not in ('ended','failed')`))
      .returning();
    if (!ended) return undefined;
    await trx.delete(browserProfileLeases).where(eq(browserProfileLeases.sessionId, sessionId));
    await trx.update(browserWorkers).set({ status: "draining", heartbeatAt: sql`now()` })
      .where(eq(browserWorkers.sessionId, sessionId));
    return ended;
  });
}
