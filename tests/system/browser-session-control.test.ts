import { afterAll, beforeAll, expect, it } from "vitest";
import {
  browserProfileLeases,
  browserSessions,
} from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  acknowledgeBrowserPause,
  appendBrowserRecordingSegment,
  appendBrowserSessionActivity,
  createBrowserProfile,
  expireBrowserTakeovers,
  finishBrowserRecording,
  requestBrowserSession,
  requestBrowserTakeover,
  resolveAccountIdentity,
  resumeBrowserAutomation,
  staticSchemaGenerator,
  stopBrowserSession,
} from "@tabductor/engine";
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

async function readySession(accountId: string, name: string) {
  const profileId = await createBrowserProfile(handle.db, { accountId, name });
  const sessionId = await requestBrowserSession(handle.db, { accountId, profileId });
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
  const stopped = await stopBrowserSession(handle.db, { accountId, sessionId });
  expect(stopped).toMatchObject({ status: "stopping", inputOwner: "paused", inputOwnerGeneration: 4 });

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
