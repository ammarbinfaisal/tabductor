import { publish } from "@tabductor/bus";
import { runs, type Db, type RunRow } from "@tabductor/db";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";

/**
 * Run status machine (§4). Status is `text`, not a pg enum, so `awaiting_approval`
 * (Phase 7) and any future state arrive as a code change with no migration.
 *
 * Every terminal transition is one UPDATE plus its system event, published through the
 * outbox inside the same transaction — a run can never be `failed` in the DB without the
 * `run.failed` event that error-handling workflows subscribe to, or vice versa.
 *
 * Transitions are functions, not a StateMachine object: the guard is the WHERE clause,
 * which also makes each one a compare-and-set that two engine instances can race safely.
 */

export const RUN_COMPLETED = "run.completed";
export const RUN_FAILED = "run.failed";
export const RUN_TIMED_OUT = "run.timed_out";

/** Terminal statuses never transition again; the WHERE clauses below enforce it. */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

/**
 * `queued → running`. Stamps the deadline the watchdog scans, computed in the database so
 * it is on Postgres's clock rather than this process's.
 */
export async function startRun(db: Db, runId: string, timeoutMs: number | undefined): Promise<RunRow | undefined> {
  const [row] = await db
    .update(runs)
    .set({
      status: "running",
      startedAt: sql`now()`,
      heartbeatAt: sql`now()`,
      deadlineAt: timeoutMs === undefined ? null : sql`now() + ${`${timeoutMs} milliseconds`}::interval`,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "queued")))
    .returning();
  return row;
}

export type FinishInput = {
  runId: string;
  status: Extract<RunStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  error?: string;
  /** The trigger event, so the system event continues the causation chain. */
  causationId?: string | null;
  taskId: string;
};

const EVENT_FOR: Record<FinishInput["status"], string | null> = {
  succeeded: RUN_COMPLETED,
  failed: RUN_FAILED,
  timed_out: RUN_TIMED_OUT,
  cancelled: null, // no system event in the design docs; a cancel is user-initiated
};

/**
 * `running → terminal`, with its system event. Returns `undefined` when the run had
 * already reached a terminal state (the watchdog and the executor can both be racing for
 * the same hanging run — first writer wins, and only that writer publishes).
 */
export async function finishRun(db: Db, input: FinishInput): Promise<RunRow | undefined> {
  return db.transaction(async (trx) => {
    const [row] = await trx
      .update(runs)
      .set({ status: input.status, endedAt: sql`now()`, error: input.error ?? null })
      .where(and(eq(runs.id, input.runId), eq(runs.status, "running")))
      .returning();
    if (!row) return undefined;

    const type = EVENT_FOR[input.status];
    if (type) {
      await publish(trx, {
        type,
        sourceTaskId: input.taskId,
        sourceRunId: input.runId,
        causationId: input.causationId ?? null,
        packet: { runId: input.runId, taskId: input.taskId, ...(input.error ? { error: input.error } : {}) },
      });
    }
    return row;
  });
}

/**
 * Watchdog sweep: every `running` run past its deadline becomes `timed_out`.
 *
 * DB-driven rather than `setTimeout` (Phase 2 requirement) so a run started before an
 * engine restart still times out — the deadline lives in the row, not in a timer that died
 * with the process. Returns the runs it reaped.
 */
export async function reapTimedOutRuns(db: Db): Promise<RunRow[]> {
  const due = await db
    .select()
    .from(runs)
    .where(and(eq(runs.status, "running"), isNotNull(runs.deadlineAt), lte(runs.deadlineAt, sql`now()`)));

  const reaped: RunRow[] = [];
  for (const run of due) {
    const row = await finishRun(db, {
      runId: run.id,
      taskId: run.taskId,
      status: "timed_out",
      error: "run exceeded its timeout",
      causationId: run.triggerEventId,
    });
    if (row) reaped.push(row);
  }
  return reaped;
}
