import { humanActionRequests, runs, type Db } from "@tabductor/db";
import { and, eq } from "drizzle-orm";

/** Called in the authenticated browser-resume transaction; startRun assigns a new fence. */
export async function resumeHumanActions(db: Db, sessionId: string): Promise<void> {
  const requests = await db.update(humanActionRequests).set({ status: "resumed", resumedAt: new Date() })
    .where(and(eq(humanActionRequests.sessionId, sessionId), eq(humanActionRequests.status, "pending"))).returning();
  for (const request of requests) await db.update(runs).set({ status: "queued", error: null, startedAt: null, heartbeatAt: null, deadlineAt: null })
    .where(and(eq(runs.id, request.runId), eq(runs.status, "awaiting_human")));
}
