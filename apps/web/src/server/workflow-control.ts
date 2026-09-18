import { AppError } from "@tabductor/core";
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
  const internallyEmitted = new Set(graph.tasks.flatMap((task) => task.emits));
  return graph.tasks
    .filter((task) => task.consumes.length === 0 || task.consumes.every((type) => !internallyEmitted.has(type)))
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
  const { workflow, versionId } = await currentWorkflow(ctx, input.workflowId);
  const [graph, tasks] = await Promise.all([
    readGraph(ctx.db, versionId),
    listVersionTasks(ctx.db, versionId),
  ]);
  const entries = new Set(workflowEntryNames(graph));
  const taskIds = tasks.filter((task) => entries.has(task.name)).map((task) => task.id);
  if (taskIds.length === 0) {
    throw new AppError("workflow_not_triggerable", "This workflow has no externally triggerable behavior.", {
      details: { workflowId: input.workflowId },
    });
  }

  const { executionId, runs } = await ctx.db.transaction(async (trx) => {
    const executionId = await createWorkflowExecution(trx, {
      workflowId: workflow.id,
      workflowVersionId: versionId,
    });
    const runs: Awaited<ReturnType<typeof triggerTask>>[] = [];
    for (const taskId of taskIds) runs.push(await triggerTask(trx, { taskId, executionId }));
    return { executionId, runs };
  });
  return {
    workflowId: input.workflowId,
    executionId,
    accepted: runs.length,
    runs: runs.map(({ event, dispatched }) => ({
      eventId: event.eventId,
      type: event.type,
      runId: dispatched?.runId ?? null,
    })),
  };
}

/**
 * Replace the workflow-level schedule by publishing a new version. Existing authoring
 * evidence and capability proposals travel with that version; changing when work starts
 * must not erase why or with which grants the graph was published.
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
