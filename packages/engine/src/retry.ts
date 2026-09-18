import { publish } from "@tabductor/bus";
import { newId } from "@tabductor/core";
import { runs, taskState, workflowExecutions, type Db, type RunRow, type TaskRow } from "@tabductor/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * Per-task retry policy (§15). A retry is a *new run row* at attempt n+1 carrying the same
 * `trigger_event_id` — not a resurrection of the failed row, so the history of what was
 * tried stays on the runs table and `run.failed` fires once per attempt.
 */

export const RETRIES_EXHAUSTED = "system.retries_exhausted";

const retrySchema = z.object({
  max: z.number().int().nonnegative(),
  backoff_ms: z.number().nonnegative().optional(),
});

const limitsSchema = z.object({ retry: retrySchema.optional() });

export type RetryPolicy = { max: number; backoffMs: number };

/** Absent or malformed `limits_json.retry` means "no retries" — the pre-S2b behavior. */
export function parseRetry(limitsJson: unknown): RetryPolicy | undefined {
  const parsed = limitsSchema.safeParse(limitsJson);
  const retry = parsed.success ? parsed.data.retry : undefined;
  if (!retry || retry.max <= 0) return undefined;
  return { max: retry.max, backoffMs: retry.backoff_ms ?? 0 };
}

/**
 * Called after a run reaches `failed`. Either queues the next attempt or announces that the
 * policy is spent; returns the new run's id when it queued one.
 *
 * Two things are deliberate here.
 *
 * **No dedupe claim.** `createRun` claims `(task, event)` before inserting, because
 * at-least-once *delivery* must not produce two runs. A retry is not a redelivery: the
 * claim for this exact pair was taken when attempt 0 was created and is still held, so
 * going through the claim would return `duplicate` and silently kill every retry. Retries
 * bypass the claim by construction — protection against repeating a side effect belongs to
 * the packet-level idempotency key (§6), not to run creation.
 *
 * **Backoff is a column, not a timer.** `not_before` is what makes the delay survive a
 * restart; the engine's pickup poll is what honors it. It grows exponentially per attempt
 * (§15) and is computed on Postgres's clock, for the same reason `deadline_at` is.
 */
export async function scheduleRetry(
  db: Db,
  args: { run: RunRow; task: TaskRow; error?: string | null },
): Promise<string | undefined> {
  return db.transaction(async (db) => {
    const { run, task } = args;
    const [failed] = await db.select().from(runs).where(and(
      eq(runs.id, run.id), eq(runs.status, "failed"), eq(runs.leaseGeneration, run.leaseGeneration),
    )).for("update");
    if (!failed) return undefined;
    if (run.executionId) {
      const [execution] = await db.select().from(workflowExecutions).where(and(
        eq(workflowExecutions.id, run.executionId), eq(workflowExecutions.status, "running"),
      ));
      if (!execution) return undefined;
    }
    // One durable decision per failed attempt, including an exhausted policy. This also
    // makes replay after a process restart safe when the caller lost the commit response.
    const key = `retry:${run.id}`;
    const claimed = await db.insert(taskState).values({ taskId: run.taskId, key, value: {} })
      .onConflictDoNothing().returning();
    if (!claimed.length) {
      const [prior] = await db.select().from(taskState).where(and(eq(taskState.taskId, run.taskId), eq(taskState.key, key)));
      const value = prior?.value as { runId?: string } | undefined;
      return value?.runId;
    }
    const policy = parseRetry(task.limitsJson);
    const attempt = run.attempt + 1;

    if (!policy || attempt > policy.max) {
      if (policy) {
        await db.transaction((trx) =>
          publish(trx, {
            type: RETRIES_EXHAUSTED,
            executionId: run.executionId,
            sourceTaskId: run.taskId,
            sourceRunId: run.id,
            causationId: run.triggerEventId,
            packet: {
              runId: run.id,
              taskId: run.taskId,
              attempts: run.attempt + 1,
              max: policy.max,
              ...(args.error ? { error: args.error } : {}),
            },
          }),
        );
      }
      return undefined;
    }

    const runId = newId("run");
    await db.insert(runs).values({
      id: runId,
      executionId: run.executionId,
      taskId: run.taskId,
      workflowVersionId: run.workflowVersionId,
      triggerEventId: run.triggerEventId,
      status: "queued",
      modeUsed: task.mode,
      attempt,
      notBefore: sql`now() + ${`${policy.backoffMs * 2 ** (attempt - 1)} milliseconds`}::interval`,
    });
    await db.update(taskState).set({ value: { runId } }).where(and(eq(taskState.taskId, run.taskId), eq(taskState.key, key)));
    return runId;
  });
}
