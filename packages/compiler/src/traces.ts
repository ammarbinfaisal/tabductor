import { runs, traceEntries, type Db } from "@tabductor/db";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { RunTrace } from "./consistency.js";

/**
 * The traces a compile reads, loaded from `trace_entries` in the shape `checkConsistency`
 * and `compileTask` take. The compiler's own functions are pure over trace data (that
 * package's stated rule); this is the one place the rows become that data, so a production
 * caller and a test hand-building entries feed the same pipeline.
 */
export async function loadRunTraces(db: Db, runIds: string[]): Promise<RunTrace[]> {
  if (runIds.length === 0) return [];
  const rows = await db
    .select({ runId: traceEntries.runId, seq: traceEntries.seq, kind: traceEntries.kind, payload: traceEntries.payloadJson })
    .from(traceEntries)
    .where(inArray(traceEntries.runId, runIds))
    .orderBy(asc(traceEntries.runId), asc(traceEntries.seq));

  const byRun = new Map<string, RunTrace>(runIds.map((id) => [id, { runId: id, entries: [] }]));
  for (const row of rows) {
    const payload = typeof row.payload === "object" && row.payload !== null ? (row.payload as Record<string, unknown>) : {};
    byRun.get(row.runId)?.entries.push({ seq: row.seq, kind: row.kind, payload });
  }
  return runIds.map((id) => byRun.get(id)!);
}

/**
 * The most recent succeeded `ai` runs of a task other than `excludeRunId`, newest first —
 * the predecessors a fresh run is checked for consistency against. `mode_used` rather than
 * the task's current mode, because the task may have been demoted since those runs.
 */
export async function previousCleanAiRunIds(
  db: Db,
  input: { taskId: string; excludeRunId: string; limit: number },
): Promise<string[]> {
  if (input.limit <= 0) return [];
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, input.taskId),
        eq(runs.status, "succeeded"),
        eq(runs.modeUsed, "ai"),
        ne(runs.id, input.excludeRunId),
      ),
    )
    .orderBy(desc(runs.endedAt), desc(runs.id))
    .limit(input.limit);
  return rows.map((r) => r.id);
}
