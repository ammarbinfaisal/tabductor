import { claim, publish } from "@tabductor/bus";
import { AppError, newId } from "@tabductor/core";
import {
  runs,
  modelSelections,
  tasks,
  workflowExecutions,
  workflowVersions,
  workflows,
  type Db,
  type EventRow,
  type TaskRow,
  type WorkflowRow,
} from "@tabductor/db";
import type { Metrics } from "@tabductor/telemetry";
import { and, desc, eq } from "drizzle-orm";
import { admitExecutionRun, RUN_BUDGET_EXCEEDED } from "./execution-budget.js";

export const LOOP_BUDGET_EXCEEDED = "system.loop_budget_exceeded";

/** Manual and scheduled admission queue one version-pinned runtime. */
export type Dispatched = {
  runId: string;
  taskId: string;
  workflowVersionId: string;
  executionId: string | null;
};

export async function createWorkflowExecution(
  db: Db,
  input: { workflowId: string; workflowVersionId?: string; maxRuns?: number },
): Promise<string> {
  if (input.maxRuns !== undefined && (!Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 1000)) {
    throw new AppError("execution_budget_invalid", "maxRuns must be an integer between 1 and 1000");
  }
  return db.transaction(async (db) => {
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, input.workflowId)).for("update");
    if (!workflow) throw new Error(`no workflow "${input.workflowId}"`);
    if(workflow.deletingAt)throw new AppError("workflow_deleting","Workflow is being deleted");
    if (workflow.blockedReasonJson) throw new AppError("workflow_blocked", workflow.blockedReasonJson.message, { details: workflow.blockedReasonJson });
    const versionId = input.workflowVersionId ?? await latestVersionId(db, workflow);
    if (!versionId) throw new Error(`workflow "${input.workflowId}" has no published version`);
    const [version] = await db.select({ id: workflowVersions.id, definition: workflowVersions.definitionJson }).from(workflowVersions)
      .where(and(eq(workflowVersions.id, versionId), eq(workflowVersions.workflowId, workflow.id)));
    if (!version) throw new AppError("execution_version_mismatch", "execution version must belong to its workflow");
    const declaredBudget = (version.definition as { limits?: { maxRuns?: unknown } } | null)?.limits?.maxRuns;
    const versionBudget = typeof declaredBudget === "number" && Number.isSafeInteger(declaredBudget) && declaredBudget > 0 && declaredBudget <= 1000 ? declaredBudget : 1000;
    const selections = await db.select().from(modelSelections).where(eq(modelSelections.accountId, workflow.accountId));
    const selection = selections.find((s) => s.scope === workflow.id) ?? selections.find((s) => s.scope === "account");
    const executionId = newId("exec");
    await db.insert(workflowExecutions).values({
      id: executionId,
      workflowId: workflow.id,
      workflowVersionId: versionId,
      modelSelectionJson: selection ? { funding: selection.funding, provider: selection.provider, model: selection.model, credentialId: selection.credentialId } : null,
      maxHops: workflow.maxHops,
      maxRuns: Math.min(input.maxRuns ?? 1000, versionBudget),
    });
    return executionId;
  });
}

/** Output events remain durable evidence and never schedule more work. */
export async function dispatchEvent(db: Db, event: EventRow, metrics?: Metrics): Promise<Dispatched[]> {
  // Output events are evidence only. Trigger admission queues a run directly.
  return [];
}

/** Manual and scheduled admission use the same atomic run-creation path. */
export async function dispatchToTask(
  db: Db,
  taskId: string,
  event: EventRow,
  metrics?: Metrics,
): Promise<Dispatched | undefined> {
  const target = await resolveTask(db, taskId, event.executionId);
  if (!target) return undefined;
  return createRun(db, {
    task: target.task,
    event,
    workflow: target.workflow,
    versionId: target.versionId,
    metrics,
  });
}

export const MANUAL_TRIGGER = "manual.trigger";

/** Persist the trigger and admit the version-pinned runtime in one transaction. */
export async function triggerTask(
  db: Db,
  input: { taskId: string; type?: string; packet?: unknown; executionId?: string },
): Promise<{ event: EventRow; dispatched: Dispatched | undefined }> {
  return db.transaction(async (db) => {
    const target = await resolveTask(db, input.taskId, input.executionId);
    if (!target) throw new AppError("task_not_triggerable", "task or active execution does not exist in this workflow");
    const executionId = input.executionId ?? await createWorkflowExecution(db, {
      workflowId: target.workflow.id,
      workflowVersionId: target.versionId,
    });
    const event = await db.transaction((trx) =>
      publish(trx, {
        type: input.type ?? MANUAL_TRIGGER,
        executionId,
        sourceTaskId: target.task.id,
        packet: input.packet ?? {},
      }),
    );
    return { event, dispatched: await dispatchToTask(db, target.task.id, event) };
  });
}

/** Executions retain their version; new triggers use the current runtime. */
async function resolveTask(
  db: Db,
  taskId: string,
  executionId?: string | null,
): Promise<{ workflow: WorkflowRow; versionId: string; task: TaskRow } | undefined> {
  const [origin] = await db
    .select({ task: tasks, workflow: workflows })
    .from(tasks)
    .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(tasks.id, taskId));
  if (!origin || origin.workflow.deletingAt) return undefined;

  let versionId: string;
  if (executionId) {
    const [execution] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId));
    if (!execution || execution.workflowId !== origin.workflow.id || execution.status !== "running") return undefined;
    versionId = execution.workflowVersionId;
  } else {
    versionId = await latestVersionId(db, origin.workflow);
  }

  // Same version: the row we have is already the routing row.
  if (versionId === origin.task.workflowVersionId) {
    return { workflow: origin.workflow, versionId, task: origin.task };
  }

  const [current] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workflowVersionId, versionId), eq(tasks.id, versionId)));

  // A version without a runtime cannot be started.
  if (!current) return undefined;
  return { workflow: origin.workflow, versionId, task: current };
}

/** Prefer the explicitly saved version, with a fallback for historical fixtures. */
async function latestVersionId(db: Db, workflow: WorkflowRow): Promise<string> {
  if (workflow.currentVersionId) return workflow.currentVersionId;
  const [newest] = await db
    .select({ id: workflowVersions.id })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflow.id))
    .orderBy(desc(workflowVersions.createdAt), desc(workflowVersions.id))
    .limit(1);
  return newest?.id ?? "";
}

/** Claim the trigger and insert a queued run atomically under its admission budget. */
async function createRun(
  db: Db,
  args: {
    task: TaskRow;
    event: EventRow;
    workflow: WorkflowRow;
    versionId: string;
    metrics?: Metrics;
  },
): Promise<Dispatched | undefined> {
  const { task, event, workflow, versionId } = args;

  const runId = newId("run");
  const created = await db.transaction(async (trx) => {
    if ((await claim(trx, task.id, event.eventId)) === "duplicate") {
      // Not an error: at-least-once delivery meeting the claim that makes it safe. Counted
      // because a *rising* rate means the dispatcher is redelivering, and that is a symptom.
      args.metrics?.eventsDedupeDropped.add();
      return false;
    }
    if (!await admitExecutionRun(trx, {
      executionId: event.executionId, taskId: task.id, causationId: event.eventId,
      notice: ![LOOP_BUDGET_EXCEEDED, RUN_BUDGET_EXCEEDED].includes(event.type),
    })) return false;
    await trx.insert(runs).values({
      id: runId,
      executionId: event.executionId,
      taskId: task.id,
      workflowVersionId: versionId,
      triggerEventId: event.eventId,
      status: "queued",
      modeUsed: task.mode,
    });
    return true;
  });

  return created
    ? { runId, taskId: task.id, workflowVersionId: versionId, executionId: event.executionId }
    : undefined;
}
