import { newId } from "@tabductor/core";
import {
  compileJobs,
  runs,
  tasks,
  type CompileJobReason,
  type CompileJobRow,
  type Db,
  type TaskRow,
} from "@tabductor/db";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";

/**
 * The queue that makes "a separate compilation task" a fact rather than a phrasing.
 *
 * Before S6e the compile hung off the executor's `onOutcome` and was *awaited* there, inside
 * the run's own lifetime: a slow model or a wedged validation delayed the run's terminal
 * transition, and a compile that threw ran inside the same `finally` as the run's cleanup.
 * `trace-compilation.md` requires the opposite — settle the run, flush its trace, release its
 * session, and only then compile, with compilation's own outcome, timeout and retry budget.
 *
 * A table rather than an in-process array, for the same reason `endpoint_leases` is a table:
 * the claim has to survive a restart. An engine that dies mid-compile leaves a `running` row
 * whose heartbeat goes stale, and the next worker reclaims it instead of losing the
 * eligibility a real run paid for.
 *
 * The claim query never hands out a job whose source run is still in flight. That is the
 * "finish the execution first" rule, enforced where it cannot be forgotten rather than by the
 * enqueueing caller promising to be late enough.
 */

/** How long a claimed job may go without a heartbeat before another worker may take it. */
export const COMPILE_JOB_STALE_MS = 5 * 60_000;

/** Backoff between attempts of a job that failed for a reason that might not repeat. */
export const COMPILE_RETRY_DELAY_MS = 30_000;

/**
 * Queue a compile for `runId`'s trace. Returns `null` when the task already has an open job:
 * a second clean run while the first compile is still queued is *more evidence*, not a second
 * compile, and the worker loads whatever traces exist at the moment it runs.
 */
export async function enqueueCompileJob(
  db: Db,
  input: { taskId: string; runId: string; reason: CompileJobReason; contentHash: string | null; delayMs?: number },
): Promise<CompileJobRow | null> {
  const notBefore = new Date(Date.now() + (input.delayMs ?? 0));
  const [row] = await db
    .insert(compileJobs)
    .values({
      id: newId("cjob"),
      taskId: input.taskId,
      runId: input.runId,
      reason: input.reason,
      contentHash: input.contentHash,
      notBefore,
    })
    // The partial unique index on (task_id) where status in (queued, running) is what makes
    // "one open job per task" true under two engines racing, rather than usually true.
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/**
 * Claim one due job, atomically, and only if its source run has actually settled.
 *
 * `for update skip locked` inside one transaction is the same "exactly one worker takes it"
 * shape `startRun`'s compare-and-set gives the engine. The join onto `runs` is the timing rule:
 * a job whose run is still in flight is not claimable at all — it becomes due the moment the
 * engine settles that run, and no caller has to remember to be late enough.
 */
export async function claimCompileJob(db: Db, now: Date = new Date()): Promise<CompileJobRow | null> {
  const stale = new Date(now.getTime() - COMPILE_JOB_STALE_MS);
  return db.transaction(async (trx) => {
    const [pick] = await trx
      .select({ id: compileJobs.id })
      .from(compileJobs)
      .innerJoin(runs, eq(runs.id, compileJobs.runId))
      .where(
        and(
          lte(compileJobs.notBefore, now),
          inArray(runs.status, ["succeeded", "failed", "timed_out"]),
          or(
            eq(compileJobs.status, "queued"),
            and(eq(compileJobs.status, "running"), lte(compileJobs.heartbeatAt, stale)),
          ),
        ),
      )
      .orderBy(compileJobs.notBefore)
      .limit(1)
      .for("update", { of: compileJobs, skipLocked: true });
    if (!pick) return null;

    const [row] = await trx
      .update(compileJobs)
      .set({ status: "running", attempts: sql`${compileJobs.attempts} + 1`, startedAt: now, heartbeatAt: now })
      .where(eq(compileJobs.id, pick.id))
      .returning();
    return row ?? null;
  });
}

/** Keeps a long compile's claim alive. */
export async function heartbeatCompileJob(db: Db, jobId: string): Promise<void> {
  await db.update(compileJobs).set({ heartbeatAt: new Date() }).where(eq(compileJobs.id, jobId));
}

/**
 * Terminal for this job, or queued again with a backoff.
 *
 * A **refusal** is terminal on the first attempt: the model read the evidence and the gates
 * said no, and running the identical evidence through the identical gates again would say no
 * again. A **failure** — a model transport error, a database blip — is retried until the
 * budget on the row is spent. The distinction is what keeps a task that simply cannot be
 * compiled from burning a compile every half hour forever.
 */
export async function finishCompileJob(
  db: Db,
  job: CompileJobRow,
  outcome:
    | { status: "succeeded"; scriptId: string }
    | { status: "refused"; error: string }
    | { status: "failed"; error: string; retryable?: boolean },
): Promise<void> {
  const retry = outcome.status === "failed" && outcome.retryable !== false && job.attempts < job.maxAttempts;
  if (retry) {
    await db
      .update(compileJobs)
      .set({
        status: "queued",
        error: outcome.error,
        heartbeatAt: null,
        notBefore: new Date(Date.now() + COMPILE_RETRY_DELAY_MS),
      })
      .where(eq(compileJobs.id, job.id));
    return;
  }
  await db
    .update(compileJobs)
    .set({
      status: outcome.status,
      endedAt: new Date(),
      heartbeatAt: null,
      error: outcome.status === "succeeded" ? null : outcome.error,
      ...(outcome.status === "succeeded" ? { scriptId: outcome.scriptId } : {}),
    })
    .where(eq(compileJobs.id, job.id));
}

/** The task a job is for, re-read at claim time — compilation is long enough that the row it
 * started from is not necessarily the row it will finish against. */
export async function taskForJob(db: Db, job: CompileJobRow): Promise<TaskRow | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, job.taskId));
  return row ?? null;
}
