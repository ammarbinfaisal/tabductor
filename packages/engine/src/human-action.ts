import { AppError } from "@tabductor/core";
import { browserSessions, humanActionRequests, runs, browserSessionActivity, type Db, type RunRow, type TaskRow } from "@tabductor/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertRunLease } from "./run-lease.js";

/** Durable suspension; no executor, heartbeat or completion request remains alive. */
export async function requestHumanAction(db: Db, run: RunRow, task: TaskRow, input: { reason: string; resumeWhen: string }): Promise<void> {
  if (task.kind !== "browser" || !run.executionId) throw new AppError("human_action_unavailable", "Human action requires an execution-owned browser session");
  if (!input.reason.trim() || input.reason.length > 1000 || !input.resumeWhen.trim() || input.resumeWhen.length > 1000)
    throw new AppError("human_action_invalid", "Provide a bounded reason and resume condition");
  await db.transaction(async trx => {
    await assertRunLease(trx, run.id, run.leaseGeneration);
    const [session] = await trx.select().from(browserSessions).where(and(eq(browserSessions.executionId, run.executionId!), inArray(browserSessions.status, ["ready", "running"]))).for("update");
    if (!session) throw new AppError("human_action_unavailable", "No live execution browser is available");
    await trx.insert(humanActionRequests).values({ runId: run.id, sessionId: session.id, reason: input.reason, resumeWhen: input.resumeWhen })
      .onConflictDoUpdate({ target: humanActionRequests.runId, set: { reason: input.reason, resumeWhen: input.resumeWhen, status: "pending", resumedAt: null } });
    await trx.update(runs).set({ status: "awaiting_human", deadlineAt: null, error: `human_action_required: ${input.reason}` }).where(eq(runs.id, run.id));
    if (session.inputOwner === "ai") await trx.update(browserSessions).set({ inputOwner: "paused", inputOwnerGeneration: sql`${browserSessions.inputOwnerGeneration} + 1`,
      pauseRequestedAt: new Date(), pauseAcknowledgedAt: null, takeoverExpiresAt: null, humanActionPending: true }).where(eq(browserSessions.id, session.id));
    else await trx.update(browserSessions).set({ takeoverExpiresAt: null, humanActionPending: true }).where(eq(browserSessions.id, session.id));
    await trx.insert(browserSessionActivity).values({ sessionId: session.id, kind: "human_action_requested", offsetMs: 0,
      payloadJson: { runId: run.id, reason: input.reason, resumeWhen: input.resumeWhen }, private: true });
  });
}

/** Called in the authenticated browser-resume transaction; startRun assigns a new fence. */
export async function resumeHumanActions(db: Db, sessionId: string): Promise<void> {
  const requests = await db.update(humanActionRequests).set({ status: "resumed", resumedAt: new Date() })
    .where(and(eq(humanActionRequests.sessionId, sessionId), eq(humanActionRequests.status, "pending"))).returning();
  for (const request of requests) await db.update(runs).set({ status: "queued", error: null, startedAt: null, heartbeatAt: null, deadlineAt: null })
    .where(and(eq(runs.id, request.runId), eq(runs.status, "awaiting_human")));
}
