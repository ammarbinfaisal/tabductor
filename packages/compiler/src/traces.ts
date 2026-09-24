import { runs, traceEntries, type Db } from "@tabductor/db";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { RunTrace } from "./evidence.js";

/**
 * The traces a compile reads, loaded from `trace_entries` in the shape `checkConsistency`
 * and `compileTask` take. The compiler's own functions are pure over trace data (that
 * package's stated rule); this is the one place the rows become that data, so a production
 * caller and a test hand-building entries feed the same pipeline.
 */
export async function loadRunTraces(db: Db, runIds: string[], blobs?: { get(ref: string): Promise<Buffer> }): Promise<RunTrace[]> {
  if (runIds.length === 0) return [];
  const rows = await db
    .select({ runId: traceEntries.runId, seq: traceEntries.seq, kind: traceEntries.kind, payload: traceEntries.payloadJson, blobRef: traceEntries.blobRef })
    .from(traceEntries)
    .where(inArray(traceEntries.runId, runIds))
    .orderBy(asc(traceEntries.runId), asc(traceEntries.seq));

  const byRun = new Map<string, RunTrace>(runIds.map((id) => [id, { runId: id, entries: [] }]));
  for (const row of rows) {
    let payload = typeof row.payload === "object" && row.payload !== null ? (row.payload as Record<string, unknown>) : {};
    if (payload.evidenceArtifact === true && row.blobRef && blobs) {
      const bytes = await blobs.get(row.blobRef);
      if (bytes.length > 64_000_000) throw new Error("Evidence artifact exceeds budget");
      payload = JSON.parse(bytes.toString("utf8"));
    }
    const evidenceKey = payload.phase === "started" ? "args" : "result";
    const result = payload[evidenceKey] as { reason?: string } | undefined;
    if (payload.action === "sdk.operation" && result?.reason === "artifact" && row.blobRef && blobs) {
      const bytes = await blobs.get(row.blobRef);
      if (bytes.length > 64_000_000) throw new Error("SDK evidence artifact exceeds read budget");
      payload = { ...payload, [evidenceKey]: JSON.parse(bytes.toString("utf8")) };
    }
    byRun.get(row.runId)?.entries.push({ seq: row.seq, kind: row.kind, payload });
  }
  return runIds.map((id) => byRun.get(id)!);
}

/**
 * The most recent succeeded `ai` runs of a task other than `excludeRunId`, newest first — the
 * *supporting* evidence a compile gets alongside the run that made the task eligible. They
 * widen what a plan may be grounded in, and a plan that ignores work one of them did is
 * refused (`plan.ts`); they are never compared step for step. `mode_used` rather than the
 * task's current mode, because the task may have been demoted since those runs.
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
