import { AppError } from "@tabductor/core";
import type { BlobStore } from "@tabductor/browser/blob-store";
import { browserRecordingSegments, browserSessions, type Db } from "@tabductor/db";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { withEnvelope, type EncryptedEnvelope, type KeyWrapper } from "@tabductor/secrets";

/** Seven days after session creation; encrypted media objects are unique to their segments. */
export async function expireBrowserRecordings(db: Db, blobs: BlobStore, now = new Date()): Promise<number> {
  if (!blobs.remove) throw new AppError("media_cleanup_unavailable", "recording storage must support deletion");
  const rows = await db.select({ segment: browserRecordingSegments, sessionId: browserSessions.id }).from(browserRecordingSegments)
    .innerJoin(browserSessions, eq(browserSessions.id, browserRecordingSegments.sessionId))
    .where(and(lt(browserSessions.createdAt, new Date(now.getTime() - 7 * 86400_000)), sql`${browserRecordingSegments.objectRef} is not null`)).limit(200);
  for (const { segment, sessionId } of rows) {
    await db.update(browserSessions).set({ recordingStatus: "expired" }).where(eq(browserSessions.id, sessionId));
    await blobs.remove(segment.objectRef!);
    await db.update(browserRecordingSegments).set({ objectRef: null, status: "gap" }).where(eq(browserRecordingSegments.id, segment.id));
  }
  return rows.length;
}

export async function readBrowserMedia(db: Db, blobs: BlobStore, wrapper: KeyWrapper,
  input: { accountId: string; sessionId: string; sequence?: number }) {
  const [session] = await db.select().from(browserSessions).where(and(eq(browserSessions.id, input.sessionId), eq(browserSessions.accountId, input.accountId)));
  if (!session || session.recordingStatus === "expired" || session.createdAt.getTime() < Date.now() - 7 * 86400_000) throw new AppError("browser_media_not_found", "recording is unavailable");
  const segments = await db.select().from(browserRecordingSegments).where(eq(browserRecordingSegments.sessionId, session.id)).orderBy(asc(browserRecordingSegments.sequence));
  if (input.sequence !== undefined) {
    const segment = segments.find((item) => item.sequence === input.sequence && item.status === "ready");
    if (!segment?.objectRef) throw new AppError("browser_media_not_found", "recording segment is unavailable");
    const envelope = JSON.parse((await blobs.get(segment.objectRef)).toString()) as EncryptedEnvelope;
    return { mime: "video/mp2t", bytes: await withEnvelope(wrapper, envelope, async (bytes) => Buffer.from(bytes)) };
  }
  const ready = segments.filter((item) => item.status === "ready");
  const maxDuration = Math.max(2, ...ready.map((item) => Math.ceil((item.endMs - item.startMs) / 1000)));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${maxDuration}`, "#EXT-X-MEDIA-SEQUENCE:0"];
  for (const item of ready) lines.push("#EXT-X-DISCONTINUITY", `#EXTINF:${((item.endMs - item.startMs) / 1000).toFixed(3)},`, `${item.sequence}.ts`);
  if (["ended", "failed"].includes(session.status)) lines.push("#EXT-X-ENDLIST");
  return { mime: "application/vnd.apple.mpegurl", bytes: Buffer.from(lines.join("\n") + "\n") };
}
