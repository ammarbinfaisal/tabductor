import { AppError, newId } from "@tabductor/core";
import { resumeHumanActions } from "./human-action.js";
import {
  browserAllocationRequests,
  browserProfileLeases,
  browserRecordingSegments,
  browserSessionActivity,
  browserSessions,
  browserProfiles,
  workflowExecutions,
  workflows,
  type BrowserInputOwner,
  type BrowserRecordingSegmentStatus,
  type BrowserRecordingStatus,
  type BrowserSessionRow,
  type Db,
} from "@tabductor/db";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

const ACTIVE_SESSION_STATUSES = ["ready", "running"] as const;
const TAKEOVER_TTL_MS = 10 * 60 * 1_000;
const ACTIVITY_PAGE_MAX = 200;

/** Profile setup has human ownership until stopped; automation takeover has a lease. */
export function browserControlIsActive(session: Pick<BrowserSessionRow, "executionId" | "inputOwner" | "takeoverExpiresAt"> & { humanActionPending?: boolean }, now = Date.now()): boolean {
  return session.inputOwner === "human" && (session.executionId === null || session.humanActionPending === true || (session.takeoverExpiresAt?.getTime() ?? 0) > now);
}

export type BrowserSessionControlState = Pick<
  BrowserSessionRow,
  | "id"
  | "status"
  | "generation"
  | "inputOwner"
  | "inputOwnerGeneration"
  | "automationAcknowledgedGeneration"
  | "pauseRequestedAt"
  | "pauseAcknowledgedAt"
  | "takeoverExpiresAt"
>;

function controlState(row: BrowserSessionRow): BrowserSessionControlState {
  return {
    id: row.id,
    status: row.status,
    generation: row.generation,
    inputOwner: row.inputOwner,
    inputOwnerGeneration: row.inputOwnerGeneration,
    automationAcknowledgedGeneration: row.automationAcknowledgedGeneration,
    pauseRequestedAt: row.pauseRequestedAt,
    pauseAcknowledgedAt: row.pauseAcknowledgedAt,
    takeoverExpiresAt: row.takeoverExpiresAt,
  };
}

function assertTakeoverTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 30 * 60 * 1_000) {
    throw new AppError("browser_takeover_ttl_invalid", "takeover timeout must be between 30 seconds and 30 minutes");
  }
}

async function ownedSession(db: Db, accountId: string, sessionId: string): Promise<BrowserSessionRow> {
  const [session] = await db.select().from(browserSessions).where(and(
    eq(browserSessions.id, sessionId),
    eq(browserSessions.accountId, accountId),
  ));
  if (!session) throw new AppError("browser_session_not_found", "browser session does not exist");
  return session;
}

async function appendControlActivity(
  db: Db,
  input: { sessionId: string; kind: string; payload?: Record<string, unknown>; private?: boolean },
): Promise<void> {
  await db.insert(browserSessionActivity).values({
    sessionId: input.sessionId,
    kind: input.kind,
    offsetMs: sql`greatest(0, extract(epoch from (now() - (select coalesce(ready_at, created_at) from browser_sessions where id = ${input.sessionId}))) * 1000)::int`,
    payloadJson: input.payload ?? {},
    private: input.private ?? false,
  });
}

/**
 * Revokes the current automation generation and asks the worker to stop at a command
 * boundary. Human input is not permitted until `acknowledgeBrowserPause` changes the owner
 * from `paused` to `human`.
 */
export async function requestBrowserTakeover(
  db: Db,
  input: { accountId: string; sessionId: string; ttlMs?: number },
): Promise<BrowserSessionControlState> {
  const ttlMs = input.ttlMs ?? TAKEOVER_TTL_MS;
  assertTakeoverTtl(ttlMs);
  const expiresAt = new Date(Date.now() + ttlMs);

  return db.transaction(async (trx) => {
    const [updated] = await trx.update(browserSessions).set({
      inputOwner: "paused",
      inputOwnerGeneration: sql`${browserSessions.inputOwnerGeneration} + 1`,
      pauseRequestedAt: sql`now()`,
      pauseAcknowledgedAt: null,
      takeoverExpiresAt: sql`case when ${browserSessions.executionId} is null then null else ${expiresAt}::timestamptz end`,
    }).where(and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.accountId, input.accountId),
      inArray(browserSessions.inputOwner, ["ai", "paused"]),
      inArray(browserSessions.status, ACTIVE_SESSION_STATUSES),
    )).returning();
    if (!updated) {
      const current = await ownedSession(trx, input.accountId, input.sessionId);
      throw new AppError("browser_takeover_conflict", `browser input is ${current.inputOwner} while session is ${current.status}`);
    }
    await appendControlActivity(trx, {
      sessionId: input.sessionId,
      kind: "takeover_requested",
      payload: { inputOwnerGeneration: updated.inputOwnerGeneration },
      private: true,
    });
    return controlState(updated);
  });
}

/** Worker-side acknowledgement, fenced by both allocation and input-owner generations. */
export async function acknowledgeBrowserPause(
  db: Db,
  input: { sessionId: string; generation: number; inputOwnerGeneration: number },
): Promise<BrowserSessionControlState> {
  return db.transaction(async (trx) => {
    const [updated] = await trx.update(browserSessions).set({
      inputOwner: "human",
      pauseAcknowledgedAt: sql`now()`,
    }).where(and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.generation, input.generation),
      eq(browserSessions.inputOwnerGeneration, input.inputOwnerGeneration),
      eq(browserSessions.inputOwner, "paused"),
      inArray(browserSessions.status, ACTIVE_SESSION_STATUSES),
      or(isNull(browserSessions.executionId), eq(browserSessions.humanActionPending, true), gt(browserSessions.takeoverExpiresAt, sql`now()`)),
    )).returning();
    if (!updated) throw new AppError("browser_pause_stale", "browser pause acknowledgement lost ownership");
    await appendControlActivity(trx, {
      sessionId: input.sessionId,
      kind: "takeover_started",
      payload: { inputOwnerGeneration: updated.inputOwnerGeneration },
      private: true,
    });
    return controlState(updated);
  });
}

/** Explicitly returns input to automation. The new generation forces fresh perception. */
export async function resumeBrowserAutomation(
  db: Db,
  input: { accountId: string; sessionId: string },
): Promise<BrowserSessionControlState> {
  return db.transaction(async (trx) => {
    const [updated] = await trx.update(browserSessions).set({
      inputOwner: "ai",
      humanActionPending: false,
      inputOwnerGeneration: sql`${browserSessions.inputOwnerGeneration} + 1`,
      pauseRequestedAt: null,
      pauseAcknowledgedAt: null,
      takeoverExpiresAt: null,
    }).where(and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.accountId, input.accountId),
      inArray(browserSessions.inputOwner, ["paused", "human"]),
      isNotNull(browserSessions.executionId),
      inArray(browserSessions.status, ACTIVE_SESSION_STATUSES),
    )).returning();
    if (!updated) {
      const current = await ownedSession(trx, input.accountId, input.sessionId);
      throw new AppError("browser_resume_conflict", `browser input is ${current.inputOwner} while session is ${current.status}`);
    }
    await appendControlActivity(trx, {
      sessionId: input.sessionId,
      kind: "automation_resume_requested",
      payload: { inputOwnerGeneration: updated.inputOwnerGeneration, requiresFreshPerception: true },
    });
    await resumeHumanActions(trx, input.sessionId);
    return controlState(updated);
  });
}

/** Resume becomes usable only after the worker drains old commands and acknowledges it. */
export async function acknowledgeBrowserResume(db: Db,
  input: { sessionId: string; generation: number; inputOwnerGeneration: number },
): Promise<boolean> {
  return db.transaction(async trx => {
    const [updated] = await trx.update(browserSessions).set({ automationAcknowledgedGeneration: input.inputOwnerGeneration })
      .where(and(eq(browserSessions.id, input.sessionId), eq(browserSessions.generation, input.generation),
        eq(browserSessions.inputOwnerGeneration, input.inputOwnerGeneration), eq(browserSessions.inputOwner, "ai"),
        inArray(browserSessions.status, ACTIVE_SESSION_STATUSES),
        sql`${browserSessions.automationAcknowledgedGeneration} < ${input.inputOwnerGeneration}`)).returning();
    if (!updated) return false;
    await appendControlActivity(trx, { sessionId: input.sessionId, kind: "automation_resumed",
      payload: { inputOwnerGeneration: input.inputOwnerGeneration, requiresFreshPerception: true } });
    return true;
  });
}

export function browserAutomationIsReady(session: Pick<BrowserSessionRow, "inputOwner" | "inputOwnerGeneration" | "automationAcknowledgedGeneration">): boolean {
  return session.inputOwner === "ai" && session.automationAcknowledgedGeneration === session.inputOwnerGeneration;
}

/**
 * Stops queued work immediately and asks an allocated worker to stop. The input generation
 * is always revoked first so no command from the previous owner can cross the stop boundary.
 */
export async function stopBrowserSession(
  db: Db,
  input: { accountId: string; sessionId: string },
): Promise<BrowserSessionControlState> {
  return db.transaction(async (trx) => {
    const session = await ownedSession(trx, input.accountId, input.sessionId);
    if (session.status === "ended" || session.status === "failed") return controlState(session);
    if (session.status === "stopping") return controlState(session);

    const canEndNow = session.status === "queued";
    const [updated] = await trx.update(browserSessions).set({
      status: canEndNow ? "ended" : "stopping",
      inputOwner: "paused",
      inputOwnerGeneration: sql`${browserSessions.inputOwnerGeneration} + 1`,
      takeoverExpiresAt: null,
      ...(canEndNow ? { endedAt: sql`now()` } : {}),
    }).where(and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.accountId, input.accountId),
      eq(browserSessions.generation, session.generation),
      eq(browserSessions.status, session.status),
    )).returning();
    if (!updated) throw new AppError("browser_stop_stale", "browser session changed while stopping");

    if (canEndNow) {
      await trx.update(browserAllocationRequests).set({ status: "cancelled" })
        .where(eq(browserAllocationRequests.sessionId, input.sessionId));
      await trx.delete(browserProfileLeases).where(eq(browserProfileLeases.sessionId, input.sessionId));
    }
    await appendControlActivity(trx, {
      sessionId: input.sessionId,
      kind: "session_stop_requested",
      payload: { immediate: canEndNow, inputOwnerGeneration: updated.inputOwnerGeneration },
    });
    return controlState(updated);
  });
}

/** Execution-owned browsers survive packet completion and close after all work settles. */
export async function stopFinishedExecutionBrowsers(db: Db): Promise<number> {
  const sessions = await db.select({ id: browserSessions.id, accountId: browserSessions.accountId }).from(browserSessions)
    .where(and(inArray(browserSessions.status, ["queued", "allocating", "ready", "running"]),
      sql`exists (select 1 from workflow_executions x where x.id = ${browserSessions.executionId} and x.status <> 'running')`));
  for (const session of sessions) await stopBrowserSession(db, { accountId: session.accountId, sessionId: session.id });
  return sessions.length;
}

/** Expired takeover windows remain paused; resuming automation is always explicit. */
export async function expireBrowserTakeovers(db: Db, now = new Date()): Promise<number> {
  return db.transaction(async (trx) => {
    const expired = await trx.update(browserSessions).set({
      inputOwner: "paused",
      inputOwnerGeneration: sql`${browserSessions.inputOwnerGeneration} + 1`,
      takeoverExpiresAt: null,
    }).where(and(
      eq(browserSessions.inputOwner, "human"),
      eq(browserSessions.humanActionPending, false),
      isNotNull(browserSessions.executionId),
      lte(browserSessions.takeoverExpiresAt, now),
      inArray(browserSessions.status, ACTIVE_SESSION_STATUSES),
    )).returning({ id: browserSessions.id, inputOwnerGeneration: browserSessions.inputOwnerGeneration });
    if (expired.length > 0) {
      await trx.insert(browserSessionActivity).values(expired.map((session) => ({
        sessionId: session.id,
        kind: "takeover_expired",
        payloadJson: { inputOwnerGeneration: session.inputOwnerGeneration },
        private: true,
      })));
    }
    return expired.length;
  });
}

const SENSITIVE_ACTIVITY_KEY = /(?:authorization|cookie|credential|key(?:stroke)?|password|secret|token|value)/i;

function activityPayloadIsSafe(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(activityPayloadIsSafe);
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, child]) => !SENSITIVE_ACTIVITY_KEY.test(key) && activityPayloadIsSafe(child));
}

/** Worker-side durable activity write. Generic sensitive-looking fields are rejected. */
export async function appendBrowserSessionActivity(
  db: Db,
  input: {
    sessionId: string;
    generation: number;
    kind: string;
    offsetMs: number;
    pageId?: string;
    payload?: Record<string, unknown>;
    private?: boolean;
  },
): Promise<number> {
  if (!activityPayloadIsSafe(input.payload ?? {})) {
    throw new AppError("browser_activity_sensitive", "session activity cannot contain sensitive values");
  }
  return db.transaction(async (trx) => {
    const [session] = await trx.select({ id: browserSessions.id }).from(browserSessions).where(and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.generation, input.generation),
      inArray(browserSessions.status, ["ready", "running", "stopping"]),
    )).for("update");
    if (!session) throw new AppError("browser_session_stale", "browser session lost ownership");
    const [row] = await trx.insert(browserSessionActivity).values({
      sessionId: input.sessionId,
      kind: input.kind,
      offsetMs: input.offsetMs,
      pageId: input.pageId ?? null,
      payloadJson: input.payload ?? {},
      private: input.private ?? false,
    }).returning({ cursor: browserSessionActivity.cursor });
    return row!.cursor;
  });
}

export async function listBrowserSessionActivity(
  db: Db,
  input: { accountId: string; sessionId: string; after?: number; limit?: number },
) {
  await ownedSession(db, input.accountId, input.sessionId);
  const limit = Math.max(1, Math.min(input.limit ?? 100, ACTIVITY_PAGE_MAX));
  return db.select().from(browserSessionActivity).where(and(
    eq(browserSessionActivity.sessionId, input.sessionId),
    gt(browserSessionActivity.cursor, input.after ?? 0),
  )).orderBy(asc(browserSessionActivity.cursor)).limit(limit);
}

export async function appendBrowserRecordingSegment(
  db: Db,
  input: {
    sessionId: string;
    generation: number;
    sequence: number;
    startMs: number;
    endMs: number;
    status: BrowserRecordingSegmentStatus;
    objectRef?: string;
  },
): Promise<string> {
  if ((input.status === "ready") !== Boolean(input.objectRef)) {
    throw new AppError("browser_recording_segment_invalid", "only ready recording segments have an object reference");
  }
  return db.transaction(async (trx) => {
    const [session] = await trx.update(browserSessions).set({
      recordingStatus: "recording",
      recordingStartedAt: sql`coalesce(${browserSessions.recordingStartedAt}, now())`,
    }).where(and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.generation, input.generation),
      inArray(browserSessions.status, ["ready", "running", "stopping"]),
    )).returning({ id: browserSessions.id });
    if (!session) throw new AppError("browser_session_stale", "browser session lost ownership");
    const id = newId("segment");
    await trx.insert(browserRecordingSegments).values({
      id,
      sessionId: input.sessionId,
      sequence: input.sequence,
      startMs: input.startMs,
      endMs: input.endMs,
      status: input.status,
      objectRef: input.objectRef ?? null,
    });
    return id;
  });
}

export async function finishBrowserRecording(
  db: Db,
  input: { sessionId: string; generation: number; status: Extract<BrowserRecordingStatus, "complete" | "partial"> },
): Promise<void> {
  const [updated] = await db.update(browserSessions).set({
    recordingStatus: input.status,
    recordingEndedAt: sql`now()`,
  }).where(and(
    eq(browserSessions.id, input.sessionId),
    eq(browserSessions.generation, input.generation),
    eq(browserSessions.recordingStatus, "recording"),
  )).returning({ id: browserSessions.id });
  if (!updated) throw new AppError("browser_recording_stale", "browser recording lost ownership");
}

export async function getBrowserSessionPlayback(
  db: Db,
  input: { accountId: string; sessionId: string },
) {
  const session = await ownedSession(db, input.accountId, input.sessionId);
  const [names] = await db.select({ workflowName: workflows.name, profileName: browserProfiles.name }).from(browserSessions)
    .leftJoin(workflowExecutions, eq(workflowExecutions.id, browserSessions.executionId))
    .leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .leftJoin(browserProfiles, eq(browserProfiles.id, browserSessions.profileId))
    .where(eq(browserSessions.id, input.sessionId));
  const segments = await db.select().from(browserRecordingSegments)
    .where(eq(browserRecordingSegments.sessionId, input.sessionId))
    .orderBy(asc(browserRecordingSegments.sequence));
  const [blockingSession] = session.status === "queued" ? await db.select({ id: browserSessions.id })
    .from(browserProfileLeases).innerJoin(browserSessions, eq(browserSessions.id, browserProfileLeases.sessionId))
    .where(and(eq(browserProfileLeases.profileId, session.profileId), eq(browserSessions.accountId, input.accountId))) : [];
  return { session, segments, name: names?.workflowName ?? names?.profileName ?? "Browser session", waitingForSessionId: blockingSession?.id ?? null };
}
