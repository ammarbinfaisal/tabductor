import { afterAll, beforeAll, expect, it } from "vitest";
import {
  browserProfileLeases,
  browserSessions,
} from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { acknowledgeBrowserPause, acknowledgeBrowserResume, browserAutomationIsReady, appendBrowserRecordingSegment, appendBrowserSessionActivity, createBrowserProfile, createWorkflow, createWorkflowExecution, browserControlIsActive, expireBrowserTakeovers, finishBrowserRecording, requestBrowserSession, requestBrowserTakeover, resolveAccountIdentity, resumeBrowserAutomation, stopBrowserSession } from "@tabductor/engine";
import { publishVersion, staticSchemaGenerator } from "@tabductor/engine/testing";
import { eq } from "drizzle-orm";
import { createCaller } from "../../apps/web/src/server/router.js";

let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });

const callerFor = (accountId: string) => createCaller({
  db: handle.db,
  pool: handle.pool,
  accountId,
  schemaGenerator: staticSchemaGenerator({}),
});

async function readySession(accountId: string, name: string, setup = false) {
  const profileId = await createBrowserProfile(handle.db, { accountId, name });
  let executionId: string | undefined;
  if (!setup) {
    const workflowId = await createWorkflow(handle.db, { accountId, name, userId: "test" });
    await publishVersion(handle.db, { workflowId, graph: { tasks: [], events: [] } }, { schemaGenerator: staticSchemaGenerator() });
    executionId = await createWorkflowExecution(handle.db, { workflowId });
  }
  const sessionId = await requestBrowserSession(handle.db, { accountId, profileId, executionId });
  await handle.db.update(browserSessions).set({ status: "ready", readyAt: new Date() })
    .where(eq(browserSessions.id, sessionId));
  return { profileId, sessionId };
}

it("fences takeover, resume, activity, and recording writes by generation", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "session_owner" });
  const { sessionId } = await readySession(accountId, "Takeover profile");

  const paused = await requestBrowserTakeover(handle.db, { accountId, sessionId, ttlMs: 30_000 });
  expect(paused).toMatchObject({ inputOwner: "paused", generation: 1, inputOwnerGeneration: 2 });

  await expect(acknowledgeBrowserPause(handle.db, {
    sessionId,
    generation: 1,
    inputOwnerGeneration: 1,
  })).rejects.toMatchObject({ code: "browser_pause_stale" });
  const human = await acknowledgeBrowserPause(handle.db, {
    sessionId,
    generation: 1,
    inputOwnerGeneration: 2,
  });
  expect(human.inputOwner).toBe("human");
  expect(human.pauseAcknowledgedAt).toBeInstanceOf(Date);

  const cursor = await appendBrowserSessionActivity(handle.db, {
    sessionId,
    generation: 1,
    kind: "action",
    offsetMs: 125,
    payload: { action: "click", selector: "#continue" },
  });
  expect(cursor).toBeGreaterThan(0);
  await expect(appendBrowserSessionActivity(handle.db, {
    sessionId,
    generation: 1,
    kind: "human_input",
    offsetMs: 130,
    payload: { keystrokes: "must-not-persist" },
  })).rejects.toMatchObject({ code: "browser_activity_sensitive" });

  await appendBrowserRecordingSegment(handle.db, {
    sessionId,
    generation: 1,
    sequence: 0,
    startMs: 0,
    endMs: 1_000,
    status: "ready",
    objectRef: "recordings/session/0.ts",
  });
  await appendBrowserRecordingSegment(handle.db, {
    sessionId,
    generation: 1,
    sequence: 1,
    startMs: 1_000,
    endMs: 1_500,
    status: "private",
  });
  await finishBrowserRecording(handle.db, { sessionId, generation: 1, status: "complete" });

  const resumed = await resumeBrowserAutomation(handle.db, { accountId, sessionId });
  expect(resumed).toMatchObject({ inputOwner: "ai", inputOwnerGeneration: 3 });
  expect(browserAutomationIsReady(resumed)).toBe(false);
  expect(await acknowledgeBrowserResume(handle.db, { sessionId, generation: 1, inputOwnerGeneration: 2 })).toBe(false);
  expect(await acknowledgeBrowserResume(handle.db, { sessionId, generation: 1, inputOwnerGeneration: 3 })).toBe(true);
  const [acknowledged] = await handle.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
  expect(browserAutomationIsReady(acknowledged!)).toBe(true);
  const stopped = await stopBrowserSession(handle.db, { accountId, sessionId });
  expect(stopped).toMatchObject({ status: "stopping", inputOwner: "paused", inputOwnerGeneration: 4 });
  expect(await acknowledgeBrowserResume(handle.db, { sessionId, generation: 1, inputOwnerGeneration: 3 })).toBe(false);

  await expect(appendBrowserSessionActivity(handle.db, {
    sessionId,
    generation: 0,
    kind: "stale_action",
    offsetMs: 500,
  })).rejects.toMatchObject({ code: "browser_session_stale" });
});

it("keeps expired human control paused until an explicit resume", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "takeover_timeout" });
  const { sessionId } = await readySession(accountId, "Timeout profile");
  const paused = await requestBrowserTakeover(handle.db, { accountId, sessionId, ttlMs: 30_000 });
  await acknowledgeBrowserPause(handle.db, {
    sessionId,
    generation: paused.generation,
    inputOwnerGeneration: paused.inputOwnerGeneration,
  });

  expect(await expireBrowserTakeovers(handle.db, new Date(Date.now() + 31_000))).toBe(1);
  const [expired] = await handle.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
  expect(expired).toMatchObject({ inputOwner: "paused", inputOwnerGeneration: 3, takeoverExpiresAt: null });

  const resumed = await resumeBrowserAutomation(handle.db, { accountId, sessionId });
  expect(resumed).toMatchObject({ inputOwner: "ai", inputOwnerGeneration: 4 });
});

it("keeps profile control indefinitely while automation still requires an unexpired takeover", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "profile_control" });
  const { sessionId } = await readySession(accountId, "Sign in", true);
  const paused = await requestBrowserTakeover(handle.db, { accountId, sessionId });
  expect(paused.takeoverExpiresAt).toBeNull();
  await acknowledgeBrowserPause(handle.db, { sessionId, generation: paused.generation, inputOwnerGeneration: paused.inputOwnerGeneration });
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await expireBrowserTakeovers(handle.db, future);
  const [session] = await handle.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
  expect(session).toMatchObject({ inputOwner: "human", takeoverExpiresAt: null });
  expect(browserControlIsActive(session!, future.getTime())).toBe(true);
  expect(browserControlIsActive({ ...session!, executionId: "automation" }, future.getTime())).toBe(false);
  expect(browserControlIsActive({ ...session!, inputOwner: "paused" }, future.getTime())).toBe(false);
  await expect(resumeBrowserAutomation(handle.db, { accountId, sessionId })).rejects.toMatchObject({ code: "browser_resume_conflict" });
  await stopBrowserSession(handle.db, { accountId, sessionId });
  const [stopped] = await handle.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
  expect(browserControlIsActive(stopped!)).toBe(false);
});

it("enforces account ownership in the session API and exposes ordered playback metadata", async () => {
  const owner = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "playback_owner" });
  const stranger = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "playback_stranger" });
  const { sessionId } = await readySession(owner, "Playback profile");
  await appendBrowserSessionActivity(handle.db, {
    sessionId,
    generation: 1,
    kind: "navigation",
    offsetMs: 10,
    payload: { url: "https://example.test/" },
  });
  await appendBrowserRecordingSegment(handle.db, {
    sessionId,
    generation: 1,
    sequence: 2,
    startMs: 1_000,
    endMs: 2_000,
    status: "gap",
  });
  await appendBrowserRecordingSegment(handle.db, {
    sessionId,
    generation: 1,
    sequence: 1,
    startMs: 0,
    endMs: 1_000,
    status: "ready",
    objectRef: "recordings/playback/1.ts",
  });

  await expect(callerFor(stranger).browserSession.get({ sessionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const playback = await callerFor(owner).browserSession.get({ sessionId });
  expect(playback.segments.map((segment) => segment.sequence)).toEqual([1, 2]);
  const activity = await callerFor(owner).browserSession.activity({ sessionId, after: 0 });
  expect(activity.map((entry) => entry.kind)).toContain("navigation");
});

it("cancels unallocated sessions and releases their profile lease", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "queued_stop" });
  const profileId = await createBrowserProfile(handle.db, { accountId, name: "Queued profile" });
  const sessionId = await requestBrowserSession(handle.db, { accountId, profileId });
  const stopped = await stopBrowserSession(handle.db, { accountId, sessionId });
  expect(stopped.status).toBe("ended");
  expect(await handle.db.select().from(browserProfileLeases).where(eq(browserProfileLeases.profileId, profileId))).toHaveLength(0);

  await expect(requestBrowserSession(handle.db, { accountId, profileId })).resolves.toMatch(/^session_/);
});

it("explains which owned browser blocks a queued session and clears the link after release", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "blocked_profile" });
  const { sessionId: activeId, profileId } = await readySession(accountId, "Busy profile");
  await handle.db.insert(browserProfileLeases).values({ profileId, sessionId: activeId, generation: 1 });
  const sessionId = await requestBrowserSession(handle.db, { accountId, profileId });
  const caller = callerFor(accountId);
  expect(await caller.browserSession.get({ sessionId })).toMatchObject({ waitingForSessionId: activeId });
  expect(await caller.browserSession.get({ sessionId: activeId })).toMatchObject({ waitingForSessionId: null });
  await handle.db.delete(browserProfileLeases).where(eq(browserProfileLeases.profileId, profileId));
  expect(await caller.browserSession.get({ sessionId })).toMatchObject({ waitingForSessionId: null });
});
