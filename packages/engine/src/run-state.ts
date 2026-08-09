import { publish } from "@tabductor/bus";
import { runs, schedules, type Db, type RunRow } from "@tabductor/db";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";

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
 *
 * `not_before` is part of the guard, not a separate check: a retry still inside its backoff
 * loses the CAS, so two engines racing to pick it up early both fail rather than one
 * winning. Returns `undefined` for both "already taken" and "not yet due".
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
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, "queued"),
        sql`(${runs.notBefore} is null or ${runs.notBefore} <= now())`,
      ),
    )
    .returning();
  return row;
}

/**
 * Runs waiting to execute and due to: `queued`, past `not_before`. This is how a retry that
 * was queued with a backoff, or a run inserted by a process that has since died, ever gets
 * picked up — the queue lives in the table, so nothing is lost with the process that
 * created it.
 *
 * Scheduled tasks are held back while one of their runs is still going. A schedule's
 * overlap policy (§7) is a statement that this task's runs must not overlap — `queue` lets
 * a fire *wait* behind the live run, not run alongside it, and overlapping browser runs
 * against one CDP session are the hazard the policy exists to prevent. Tasks with no
 * schedule are unaffected: fan-out concurrency stays exactly as it was.
 */
export async function dueQueuedRuns(db: Db, limit = 100): Promise<RunRow[]> {
  return db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.status, "queued"),
        sql`(${runs.notBefore} is null or ${runs.notBefore} <= now())`,
        sql`not exists (
          select 1 from ${schedules} s
          join ${runs} live on live.task_id = s.task_id and live.status = 'running'
          where s.task_id = ${runs.taskId}
        )`,
      ),
    )
    .orderBy(asc(runs.createdAt))
    .limit(limit);
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
 * User-initiated cancel (§4), the one transition the control plane drives.
 *
 * Legal from `queued` *and* `running`, unlike every other transition here — cancelling a run
 * that has not started yet is the common case, and `finishRun`'s `running`-only guard would
 * reject exactly that. A run already terminal returns `undefined`, which the API reports as
 * a conflict rather than pretending it cancelled something.
 *
 * A `running` run is not interrupted mid-executor: the status flips, the executor finishes
 * whatever it is inside, and its own terminal write then loses the CAS. Real interruption
 * needs a per-executor abort path and arrives with the browser runtime (Phase 3).
 */
export async function cancelRun(db: Db, runId: string): Promise<RunRow | undefined> {
  const [row] = await db
    .update(runs)
    .set({ status: "cancelled", endedAt: sql`now()`, error: "cancelled by user" })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])))
    .returning();
  return row;
}

/**
 * Liveness ping (§15). Best-effort and guarded on `running`, so a heartbeat that lands
 * after the watchdog already reaped the run cannot un-stale a terminal row.
 */
export async function heartbeat(db: Db, runId: string): Promise<void> {
  await db
    .update(runs)
    .set({ heartbeatAt: sql`now()` })
    .where(and(eq(runs.id, runId), eq(runs.status, "running")));
}

/**
 * Crash recovery (§15), run once on engine start: a run left `running` by a process that
 * died has a heartbeat that stopped ticking, so anything older than `staleMs` is fabricated
 * back into `failed(engine_restart)`. Returns the runs it recovered, for the caller to put
 * through the retry policy — the design says re-run from the start, never resume mid-page.
 *
 * `heartbeat_at` is nullable for runs that never got their first ping; `started_at` is the
 * fallback, and a run with neither is too young to judge.
 */
export const ENGINE_RESTART = "engine_restart";

export async function recoverStaleRuns(db: Db, staleMs: number): Promise<RunRow[]> {
  const stale = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.status, "running"),
        lte(sql`coalesce(${runs.heartbeatAt}, ${runs.startedAt})`, sql`now() - ${`${staleMs} milliseconds`}::interval`),
      ),
    );

  const recovered: RunRow[] = [];
  for (const run of stale) {
    const row = await finishRun(db, {
      runId: run.id,
      taskId: run.taskId,
      status: "failed",
      error: ENGINE_RESTART,
      causationId: run.triggerEventId,
    });
    if (row) recovered.push(row);
  }
  return recovered;
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
