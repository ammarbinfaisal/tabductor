import { recordProgress } from "@tabductor/engine";
import { AppError, promptInputsSchema, workflowPromptInputNames } from "@tabductor/core";
import { workflows, workflowTriggerRequests, workflowExecutions, runs } from "@tabductor/db";
import { and, eq } from "drizzle-orm";
import {
  getWorkflow,
  createWorkflowExecution,
  listVersionTasks,
  publishVersion,
  readGraph,
  readGraphAuthoring,
  scheduleValidationError,
  triggerTask,
  type Graph,
} from "@tabductor/engine";
import type { Context } from "./trpc.js";
import { requireWorkflowOwner } from "./trpc.js";

export type WorkflowTriggerInput = {
  workflowId: string;
  requestId?: string;
  inputs?: Record<string, string>;
};

export type WorkflowScheduleInput = {
  workflowId: string;
  schedule: { cron: string; timezone: string; enabled: boolean } | null;
};

/**
 * The internal behaviors an external workflow-level trigger should start. An entry consumes
 * nothing produced inside this graph; callers never need to learn its task id or name.
 */
export function workflowEntryNames(graph: Graph): string[] {
  if (graph.contractVersion === 2) return graph.tasks.filter((task) => task.kind !== "result" && task.entry).map((task) => task.name);
  const internallyEmitted = new Set(graph.tasks.flatMap((task) => task.emits));
  return graph.tasks
    .filter((task) => task.kind !== "result" && (task.consumes.length === 0 || task.consumes.every((type) => !internallyEmitted.has(type))))
    .map((task) => task.name);
}

async function currentWorkflow(ctx: Context, workflowId: string) {
  await requireWorkflowOwner(ctx, workflowId);
  const workflow = await getWorkflow(ctx.db, workflowId);
  if (!workflow) {
    throw new AppError("workflow_not_found", `no workflow "${workflowId}"`, { details: { workflowId } });
  }
  const versionId = workflow.currentVersionId;
  if (!versionId) {
    throw new AppError("workflow_not_published", "Publish this workflow before running or scheduling it.", {
      details: { workflowId },
    });
  }
  return { workflow, versionId };
}

/** Workflow-level manual start shared by tRPC and MCP. */
export async function triggerWorkflow(ctx: Context, input: WorkflowTriggerInput) {
  await requireWorkflowOwner(ctx, input.workflowId);
  if (input.requestId !== undefined && (!input.requestId || input.requestId.length > 200)) throw new AppError("trigger_request_invalid", "requestId must contain 1–200 characters");
  return ctx.db.transaction(async (trx) => {
    const [workflow] = await trx.select().from(workflows).where(eq(workflows.id, input.workflowId)).for("update");
    if (!workflow?.currentVersionId) throw new AppError("workflow_not_published", "Publish this workflow before running it.");
    if (input.requestId) {
      const [prior] = await trx.select().from(workflowTriggerRequests).where(and(eq(workflowTriggerRequests.workflowId, input.workflowId), eq(workflowTriggerRequests.requestId, input.requestId)));
      if (prior) return prior.resultJson;
    }
    const versionId = workflow.currentVersionId;
    const [graph, tasks] = await Promise.all([
      readGraph(trx, versionId),
      listVersionTasks(trx, versionId),
    ]);
    const parsed = promptInputsSchema.safeParse(input.inputs ?? {});
    if (!parsed.success) throw new AppError("prompt_inputs_invalid", parsed.error.message);
    const names = workflowPromptInputNames(graph);
    const missing = names.filter(name => !Object.hasOwn(parsed.data, name));
    const unknown = Object.keys(parsed.data).filter(name => !names.includes(name));
    if (missing.length || unknown.length) throw new AppError("prompt_inputs_invalid", [
      missing.length ? `Missing prompt inputs: ${missing.map(name => "$" + name).join(", ")}` : "",
      unknown.length ? `Unknown prompt inputs: ${unknown.join(", ")}` : "",
    ].filter(Boolean).join(". "));
    const packet = names.length ? { promptInputs: parsed.data } : {};
    const entries = new Set(workflowEntryNames(graph));
    const taskIds = tasks.filter((task) => entries.has(task.name)).map((task) => task.id);
    if (taskIds.length === 0) {
      throw new AppError("workflow_not_triggerable", "This workflow has no externally triggerable behavior.", {
        details: { workflowId: input.workflowId },
      });
    }

    const executionId = await createWorkflowExecution(trx, {
      workflowId: workflow.id,
      workflowVersionId: versionId,
      ...(graph.maxRuns ? { maxRuns: graph.maxRuns } : {}),
    });
    const runs: Awaited<ReturnType<typeof triggerTask>>[] = [];
    for (const taskId of taskIds) runs.push(await triggerTask(trx, { taskId, executionId, packet }));
    const result = {
      workflowId: input.workflowId,
      executionId,
      accepted: runs.length,
      runs: runs.map(({ event, dispatched }) => ({
        eventId: event.eventId,
        type: event.type,
        runId: dispatched?.runId ?? null,
      })),
    };
    if (input.requestId) await trx.insert(workflowTriggerRequests).values({ workflowId: input.workflowId, requestId: input.requestId, resultJson: result });
    return result;
  });
}

/**
 * Replace the workflow-level schedule by publishing a new version. Existing authoring
 * evidence travels with that version; changing when work starts preserves its compile report.
 */
export async function setWorkflowSchedule(ctx: Context, input: WorkflowScheduleInput) {
  const { versionId } = await currentWorkflow(ctx, input.workflowId);
  const [currentGraph, authoring] = await Promise.all([
    readGraph(ctx.db, versionId),
    readGraphAuthoring(ctx.db, versionId),
  ]);
  const entries = new Set(workflowEntryNames(currentGraph));
  if (entries.size === 0) {
    throw new AppError("workflow_not_triggerable", "This workflow has no externally triggerable behavior.", {
      details: { workflowId: input.workflowId },
    });
  }

  const scheduleError = input.schedule
    ? scheduleValidationError(input.schedule.cron.trim(), input.schedule.timezone.trim())
    : null;
  if (scheduleError) {
    throw new AppError("schedule_invalid", `Invalid schedule: ${scheduleError}`, {
      details: { cron: input.schedule?.cron, timezone: input.schedule?.timezone },
    });
  }

  const schedule = input.schedule
    ? {
        cron: input.schedule.cron.trim(),
        tz: input.schedule.timezone.trim(),
        missedPolicy: "skip" as const,
        overlapPolicy: "skip" as const,
        maxQueueDepth: 1,
        enabled: input.schedule.enabled,
      }
    : null;
  const graph: Graph = {
    ...currentGraph,
    tasks: currentGraph.tasks.map((task) => entries.has(task.name) ? { ...task, schedule } : task),
  };
  const priorAuthoring = authoring.report
    ? {
        report: authoring.report.authoring,
        proposedGrants: [],
      }
    : undefined;
  const published = await publishVersion(ctx.db, {
    workflowId: input.workflowId,
    expectedVersionId: versionId,
    graph,
    ...(priorAuthoring ? { authoring: priorAuthoring } : {}),
  }, {
    schemaGenerator: ctx.schemaGenerator,
    ...(ctx.promptCompiler ? { promptCompiler: ctx.promptCompiler } : {}),
    ...(ctx.pool ? { pool: ctx.pool } : {}),
  });

  return {
    workflowId: input.workflowId,
    versionId: published.versionId,
    schedule: input.schedule,
  };
}

/** Poll one traversal, never the latest run from a different invocation. */
export async function workflowStatus(ctx: Context, input: { workflowId: string; executionId: string }) {
  await requireWorkflowOwner(ctx, input.workflowId);
  const [execution] = await ctx.db.select().from(workflowExecutions).where(and(
    eq(workflowExecutions.id, input.executionId), eq(workflowExecutions.workflowId, input.workflowId),
  ));
  if (!execution) throw new AppError("execution_not_found", "No execution found for this workflow.");
  const terminal = execution.status !== "running";
  const attempts = terminal ? await ctx.db.select({ runId: runs.id, status: runs.status, error: runs.error })
    .from(runs).where(eq(runs.executionId, execution.id)) : [];
  return {
    workflowId: execution.workflowId, executionId: execution.id, versionId: execution.workflowVersionId,
    status: execution.blockedReasonJson && !terminal ? "blocked" as const : execution.status, finished: terminal,
    blocked: execution.blockedReasonJson, records: await recordProgress(ctx.db, execution.id),
    resultReady: terminal && execution.resultReady,
    result: terminal && execution.resultReady ? execution.resultJson : null,
    errors: attempts.filter((run) => run.error !== null),
    createdAt: execution.createdAt, endedAt: execution.endedAt,
  };
}
