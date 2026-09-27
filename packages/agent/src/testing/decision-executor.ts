import type { Pool } from "pg";
import { createTraceRecorder, type BlobStore, type StorageFlags, type TraceRecorder } from "@tabductor/browser";
import { AppError } from "@tabductor/core";
import { workflowVersions, workflows, type Db, type TaskRow } from "@tabductor/db";
import type { RunHandle, RunResult, TaskExecutor } from "@tabductor/engine";
import type { PolicyGate } from "@tabductor/core";
import {
  createWriteStager,
  flushStagedWrites,
  latestStoreSchema,
  tablesSpecOf,
} from "@tabductor/store";
import type { Metrics } from "@tabductor/telemetry";
import { eq } from "drizzle-orm";
import { buildDecisionToolRegistry } from "./decision-tools.js";
import {
  flushRemainingWrites,
  makeEmitFn,
  storageFlagsOf as defaultStorageFlagsOf,
  toRunResult,
  triggerInfoOf,
} from "../executor-shared.js";
import type { Llm } from "../llm.js";
import { runAgentLoop } from "../loop.js";

/**
 * `(decision, ai)` — the planner kind's executor (S5g, graph-compilation-llm §2). The
 * non-browser executor. It owns semantic work and workflow-store query/insert/upsert;
 * writes are staged and commit with the next emit, or on successful completion when there
 * is no later emit. It has no browser session, external MCP tools, files, or Python runtime.
 *
 * `RunHandle.trigger` here is `null` for a cron fire (§2.2: "the fire carries an empty
 * packet") and populated for an event-triggered decision node exactly as for any consumer —
 * `triggerInfoOf` does not know or care which kind called it.
 */

export type DecisionExecutorDeps = {
  db: Db;
  pool: Pool;
  gate: PolicyGate;
  blobs: BlobStore;
  llmFor: (opts: { trace: TraceRecorder; task: TaskRow; runId: string }) => Llm;
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
  const { db, pool, blobs, gate, llmFor, metrics } = deps;
  const storageFlagsOf = deps.storageFlagsOf ?? defaultStorageFlagsOf;

  return {
    async execute(handle: RunHandle): Promise<RunResult> {
      const trace = createTraceRecorder(db, blobs, handle.run.id, storageFlagsOf(handle.task));
      const stager = createWriteStager();

      try {
        const workflowId = await workflowIdForTask(db, handle.task.workflowVersionId);
        const [emits, trigger, storeSchema] = await Promise.all([
          handle.declaredEmits(),
          triggerInfoOf(db, handle),
          latestStoreSchema(db, workflowId),
        ]);

        const emit = makeEmitFn({
          db,
          taskId: handle.task.id,
          handleEmit: handle.emit,
          trace,
          drainPendingWrites: () => stager.drain(),
          restorePendingWrites: (writes) => stager.restore(writes),
          wrapPendingWrites: (writes) => flushStagedWrites(workflowId, writes),
        });
        const taskCtx = { taskId: handle.task.id, runId: handle.run.id };
        const tools = buildDecisionToolRegistry({
          pool,
          workflowId,
          emit,
          recordOutcome: handle.recordOutcome, recordCompletionError: handle.recordCompletionError,
          ...(metrics ? { metrics } : {}),
          write: {
            db,
            workflowId,
            taskId: handle.task.id,
            tablesSpec: tablesSpecOf(storeSchema),
            stager,
            policy: { gate, taskCtx },
          },
        });
        const llm = llmFor({ trace, task: handle.task, runId: handle.run.id });

        const result = await runAgentLoop({
          llm,
          tools,
          task: { prompt: handle.task.compiledPrompt ?? handle.task.prompt },
          trigger,
          emits,
          trace,
          signal: handle.signal,
        });
        if (result.outcome === "done") {
          await flushRemainingWrites({
            db,
            runId: handle.run.id,
            leaseGeneration: handle.run.leaseGeneration,
            drainPendingWrites: () => stager.drain(),
            wrapPendingWrites: (writes) => flushStagedWrites(workflowId, writes),
          });
        }
        return toRunResult(result);
      } catch (err) {
        return mapDecisionError(err);
      } finally {
        await trace.close().catch(() => undefined);
      }
    },
  };
}
