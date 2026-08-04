import { runDedupe, type Db } from "@tabductor/db";

export type ClaimResult = "claimed" | "duplicate";

/**
 * Consumer-side dedupe for at-least-once delivery (§6): the first `(task, event)` insert
 * wins, every redelivery hits the primary key and reports `duplicate`. Call it before
 * doing anything side-effectful with a delivered event.
 */
export async function claim(db: Db, taskId: string, eventId: string): Promise<ClaimResult> {
  const inserted = await db
    .insert(runDedupe)
    .values({ taskId, eventId })
    .onConflictDoNothing()
    .returning({ taskId: runDedupe.taskId });
  return inserted.length > 0 ? "claimed" : "duplicate";
}
