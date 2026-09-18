import { AppError, newId } from "@tabductor/core";
import {
  browserAllocationRequests,
  browserProfileLeases,
  browserProfiles,
  browserSessions,
  browserWorkers,
  workflowExecutions,
  workflows,
  type BrowserSessionRow,
  type Db,
} from "@tabductor/db";
import { and, eq, sql } from "drizzle-orm";

export type BrowserAdmission = {
  reserve: (input: { accountId: string; sessionId: string }, trx: Db) => Promise<void>;
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

/** Queue owned work. Profile ownership and credit admission occur when capacity is available. */
export async function requestBrowserSession(
  db: Db,
  input: { accountId: string; profileId: string; executionId?: string },
): Promise<string> {
  const [profile] = await db.select({ id: browserProfiles.id }).from(browserProfiles).where(and(
    eq(browserProfiles.id, input.profileId),
    eq(browserProfiles.accountId, input.accountId),
  ));
  if (!profile) throw new AppError("browser_profile_not_found", "browser profile does not exist");

  const sessionId = newId("session");
  await db.transaction(async (trx) => {
    if (input.executionId) {
      const [execution] = await trx.select({ id: workflowExecutions.id }).from(workflowExecutions)
        .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId)).where(and(
          eq(workflowExecutions.id, input.executionId), eq(workflows.accountId, input.accountId),
          eq(workflowExecutions.status, "running"),
        )).for("share", { of: workflowExecutions });
      if (!execution) throw new AppError("browser_execution_not_found", "active execution does not exist");
    }
    await trx.insert(browserSessions).values({
      id: sessionId,
      accountId: input.accountId,
      profileId: input.profileId,
      executionId: input.executionId ?? null,
    });
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
export async function claimBrowserAllocation(db: Db, options: {
  maxAllocated?: number;
  maxPerAccount?: number;
  admission?: BrowserAdmission;
} = {}): Promise<ClaimedBrowserAllocation | undefined> {
  const maxAllocated = options.maxAllocated ?? 3;
  const maxPerAccount = options.maxPerAccount ?? maxAllocated;
  if (![maxAllocated, maxPerAccount].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new AppError("browser_capacity_invalid", "browser capacities must be positive integers");
  }
  return db.transaction(async (trx) => {
    // A cluster-wide admission lock, held only for queue bookkeeping, serializes capacity
    // checks across controllers. Counting pods outside this transaction cannot enforce it.
    await trx.execute(sql`select pg_advisory_xact_lock(hashtextextended('browser-fleet-admission', 0))`);
    const active = await trx.execute<{ count: number }>(sql`select count(*)::int as count from browser_sessions
      where status in ('allocating','ready','running','stopping')`);
    if (active.rows[0]!.count >= maxAllocated) return undefined;
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
          and not exists (select 1 from browser_profile_leases l where l.profile_id = s.profile_id)
          and (s.execution_id is null or exists (
            select 1 from workflow_executions x where x.id = s.execution_id and x.status = 'running'
          ))
      )
      select "requestId", "sessionId", "accountId", "profileId", "generation"
      from heads where account_rank = 1 and active_count < ${maxPerAccount}
      order by active_count, created_at, "requestId"
      limit 1
    `);
    const candidate = selected.rows[0];
    if (!candidate) return undefined;
    const lease = await trx.insert(browserProfileLeases).values({
      profileId: candidate.profileId, sessionId: candidate.sessionId, generation: candidate.generation,
    }).onConflictDoNothing().returning();
    if (!lease.length) return undefined;
    const claimed = await trx.update(browserAllocationRequests).set({
      status: "claimed",
      claimedAt: sql`now()`,
      attempts: sql`${browserAllocationRequests.attempts} + 1`,
    }).where(and(
      eq(browserAllocationRequests.id, candidate.requestId),
      eq(browserAllocationRequests.status, "queued"),
    )).returning({ id: browserAllocationRequests.id });
    if (claimed.length === 0) throw new AppError("browser_allocation_stale", "browser allocation lost ownership");
    const session = await trx.update(browserSessions).set({ status: "allocating" }).where(and(
      eq(browserSessions.id, candidate.sessionId),
      eq(browserSessions.status, "queued"),
      eq(browserSessions.generation, candidate.generation),
    )).returning();
    if (!session.length) throw new AppError("browser_allocation_stale", "browser allocation lost ownership");
    await options.admission?.reserve({ accountId: candidate.accountId, sessionId: candidate.sessionId }, trx);
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
    }).onConflictDoUpdate({ target: browserWorkers.id, set: { status: "allocated", sessionId: input.sessionId, generation: input.generation } });
    const updated = await trx.update(browserSessions).set({
      status: "ready",
      inputOwner: "ai",
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
    const [updated] = await trx.update(browserSessions).set({
      status: retry ? "queued" : "failed",
      ...(retry ? { generation: sql`${browserSessions.generation} + 1` } : { endedAt: sql`now()` }),
      inputOwner: "paused",
      inputOwnerGeneration: sql`${browserSessions.inputOwnerGeneration} + 1`,
      error,
    }).where(and(
      eq(browserSessions.id, allocation.sessionId),
      eq(browserSessions.accountId, allocation.accountId),
      eq(browserSessions.generation, allocation.generation),
      eq(browserSessions.status, "allocating"),
    )).returning();
    if (!updated) throw new AppError("browser_allocation_stale", "browser allocation lost ownership");
    await trx.delete(browserProfileLeases).where(and(
      eq(browserProfileLeases.sessionId, allocation.sessionId),
      eq(browserProfileLeases.generation, allocation.generation),
    ));
    await trx.update(browserWorkers).set({ status: "draining" }).where(and(
      eq(browserWorkers.sessionId, allocation.sessionId), eq(browserWorkers.generation, allocation.generation),
    ));
    await trx.update(browserAllocationRequests).set({
      status: retry ? "queued" : "failed", claimedAt: null,
      ...(retry ? { notBefore: sql`now() + interval '2 seconds'` } : {}),
    }).where(and(
      eq(browserAllocationRequests.id, allocation.requestId),
      eq(browserAllocationRequests.sessionId, allocation.sessionId),
      eq(browserAllocationRequests.status, "claimed"),
    ));
  });
}

export async function endBrowserSession(db: Db, sessionId: string): Promise<BrowserSessionRow | undefined> {
  return db.transaction(async (trx) => {
    const [ended] = await trx.update(browserSessions).set({ status: "ended", endedAt: sql`now()`, inputOwner: "paused",
      inputOwnerGeneration: sql`${browserSessions.inputOwnerGeneration} + 1` })
      .where(and(eq(browserSessions.id, sessionId), sql`${browserSessions.status} not in ('ended','failed')`))
      .returning();
    if (!ended) return undefined;
    await trx.update(browserAllocationRequests).set({ status: "cancelled" })
      .where(eq(browserAllocationRequests.sessionId, sessionId));
    await trx.delete(browserProfileLeases).where(eq(browserProfileLeases.sessionId, sessionId));
    await trx.update(browserWorkers).set({ status: "draining", heartbeatAt: sql`now()` })
      .where(eq(browserWorkers.sessionId, sessionId));
    return ended;
  });
}
