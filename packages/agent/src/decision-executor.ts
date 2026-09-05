import type { Pool } from "pg";
import { createTraceRecorder, type BlobStore, type StorageFlags, type TraceRecorder } from "@tabductor/browser";
import { AppError } from "@tabductor/core";
import { workflowVersions, workflows, type Db, type TaskRow } from "@tabductor/db";
import type { RunHandle, RunResult, TaskExecutor } from "@tabductor/engine";
import type { Metrics } from "@tabductor/telemetry";
import { eq } from "drizzle-orm";
import { buildDecisionToolRegistry } from "./decision-tools.js";
import { makeEmitFn, maxStepsOf, storageFlagsOf as defaultStorageFlagsOf, toRunResult, triggerInfoOf } from "./executor-shared.js";
import type { Llm } from "./llm.js";
import { runAgentLoop } from "./loop.js";

/**
 * `(decision, ai)` — the planner kind's executor (S5g, graph-compilation-llm §2). The
 * smallest of the three: no browser session, no MCP connections, no asset store, no store
 * *write* stager — a decision run's "session" is `store.query` + `emit` + `done`/`fail` and
 * nothing underneath any of them needs acquiring or releasing. Everything about running
 * `runAgentLoop` behind the engine's `TaskExecutor` contract that has nothing to do with
 * *which* tools exist is `executor-shared.ts`, shared verbatim with `AssetExecutor`.
 *
 * `RunHandle.trigger` here is `null` for a cron fire (§2.2: "the fire carries an empty
 * packet") and populated for an event-triggered decision node exactly as for any consumer —
 * `triggerInfoOf` does not know or care which kind called it.
 */

export type DecisionExecutorDeps = {
  db: Db;
  pool: Pool;
  blobs: BlobStore;
  llmFor: (opts: { trace: TraceRecorder; task: TaskRow }) => Llm;
  metrics?: Metrics;
  storageFlagsOf?: (task: TaskRow) => StorageFlags;
};

async function workflowIdForTask(db: Db, workflowVersionId: string): Promise<string> {
  const rows = await db
    .select({ workflowId: workflows.id })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(workflowVersions.id, workflowVersionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new AppError("decision_task_workflow_not_found", `no workflow found for workflow_version ${workflowVersionId}`, {
      details: { workflowVersionId },
    });
  }
  return row.workflowId;
}

function mapDecisionError(err: unknown): RunResult {
  if (err instanceof AppError) return { ok: false, error: err.message };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function createDecisionExecutor(deps: DecisionExecutorDeps): TaskExecutor {
  const { db, pool, blobs, llmFor, metrics } = deps;
  const storageFlagsOf = deps.storageFlagsOf ?? defaultStorageFlagsOf;

  return {
    async execute(handle: RunHandle): Promise<RunResult> {
      const trace = createTraceRecorder(db, blobs, handle.run.id, storageFlagsOf(handle.task));

      try {
        const workflowId = await workflowIdForTask(db, handle.task.workflowVersionId);
        const [emits, trigger] = await Promise.all([handle.declaredEmits(), triggerInfoOf(db, handle)]);

        // No `drainPendingWrites`/`wrapPendingWrites` — a decision task has no store-write
        // tools at all (§2.1's kind table: "store access: read only"), so `emit` here is a
        // plain publish, identical in shape to a browser task's.
        const emit = makeEmitFn({ db, taskId: handle.task.id, handleEmit: handle.emit, trace });
        const tools = buildDecisionToolRegistry({ pool, workflowId, emit, ...(metrics ? { metrics } : {}) });
        const llm = llmFor({ trace, task: handle.task });

        const result = await runAgentLoop({
          llm,
          tools,
          task: { prompt: handle.task.compiledPrompt ?? handle.task.prompt },
          trigger,
          emits,
          trace,
          maxSteps: maxStepsOf(handle.task),
        });
        return toRunResult(result);
      } catch (err) {
        return mapDecisionError(err);
      } finally {
        await trace.close().catch(() => undefined);
      }
    },
  };
}
