import { chainDepth, claim, publish } from "@tabductor/bus";
import { AppError, newId } from "@tabductor/core";
import {
  runs,
  taskConsumes,
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

/**
 * Graph evaluation is one function, not a planner: given an event, find the tasks that
 * subscribe to its *type* in the execution's pinned workflow version, and create one `queued`
 * run per task. Execution is the caller's business.
 *
 * Routing is by type alone — the event-centric model. An event of type T reaches every
 * task consuming T in the workflow, whichever task emitted it; the emitter only matters
 * for resolving *which workflow* the event belongs to. A task that consumes a type it
 * also emits self-triggers, which is a legal cycle: the causation-chain loop budget and
 * the `(task, event)` dedupe claim below bound it exactly as they bounded edge cycles.
 */

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
    const versionId = input.workflowVersionId ?? await latestVersionId(db, workflow);
    if (!versionId) throw new Error(`workflow "${input.workflowId}" has no published version`);
    const [version] = await db.select({ id: workflowVersions.id, graph: workflowVersions.graphJson }).from(workflowVersions)
      .where(and(eq(workflowVersions.id, versionId), eq(workflowVersions.workflowId, workflow.id)));
    if (!version) throw new AppError("execution_version_mismatch", "execution version must belong to its workflow");
    const declaredBudget = (version.graph as { maxRuns?: unknown } | null)?.maxRuns;
    const versionBudget = typeof declaredBudget === "number" && Number.isSafeInteger(declaredBudget) && declaredBudget > 0 && declaredBudget <= 1000 ? declaredBudget : 1000;
    const executionId = newId("exec");
    await db.insert(workflowExecutions).values({
      id: executionId,
      workflowId: workflow.id,
      workflowVersionId: versionId,
      maxHops: workflow.maxHops,
      maxRuns: Math.min(input.maxRuns ?? 1000, versionBudget),
    });
    return executionId;
  });
}

/**
 * Resolves subscribers and creates their runs. Returns the runs created — never the ones
 * skipped by dedupe or by the loop budget.
 *
 * Hosted events route through their execution version, including downstream events and
 * retries. The latest-version fallback exists only for legacy events without an execution.
 */
export async function dispatchEvent(db: Db, event: EventRow, metrics?: Metrics): Promise<Dispatched[]> {
  const source = await resolveSource(db, event);
  if (!source) return [];

  const subscribers = await db
    .select({ task: tasks })
    .from(taskConsumes)
    .innerJoin(tasks, eq(tasks.id, taskConsumes.taskId))
    .where(
      and(
        eq(taskConsumes.workflowVersionId, source.versionId),
        eq(taskConsumes.eventType, event.type),
      ),
    );

  const created: Dispatched[] = [];
  for (const { task } of subscribers) {
    const run = await createRun(db, {
      task,
      event,
      workflow: source.workflow,
      versionId: source.versionId,
      metrics,
    });
    if (run) created.push(run);
  }
  return created;
}

/**
 * Dispatch straight *to* a task instead of along an edge — the scheduler's case (§7).
 *
 * A schedule fire is an event with no edge behind it: the schedule names its task, so
 * there is nothing to resolve subscribers from. Rather than let the scheduler create runs
 * itself, it comes through here, which routes the task forward to the latest version the
 * same way `resolveSource` does and then lands in the *same* `createRun` — one loop budget,
 * one dedupe claim, one run insert, for every way a run can come into existence.
 */
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

/**
 * Start a task by hand — the control plane's "trigger now" (U0), and structurally the same
 * move the scheduler makes: publish a synthetic event attributed to the task, then dispatch
 * it *at* that task rather than along an edge.
 *
 * The event goes through the outbox, so downstream tasks subscribed to `type` are reached
 * by ordinary delivery. The run this creates is the engine's to execute — the web process
 * only writes rows, and the two share nothing but Postgres (S2c).
 */
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

/**
 * Which graph does this event belong to, and which version routes it?
 *
 * An event's `source_task_id` points at the task row that emitted it — which belongs to
 * the version that was current *then*. Tasks are per-version rows, so the latest version
 * holds a different row for the same node; `tasks.name` is the identity that survives the
 * edit, and is what we re-resolve against.
 */
async function resolveSource(
  db: Db,
  event: EventRow,
): Promise<{ workflow: WorkflowRow; versionId: string; taskId: string } | undefined> {
  if (!event.sourceTaskId) return undefined;
  const resolved = await resolveTask(db, event.sourceTaskId, event.executionId);
  return resolved && { workflow: resolved.workflow, versionId: resolved.versionId, taskId: resolved.task.id };
}

/**
 * A task id from *some* version → the row for the same node in the latest version, with
 * the workflow it belongs to. `undefined` when the node was deleted in a newer version.
 */
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
  if (!origin) return undefined;

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
    .where(and(eq(tasks.workflowVersionId, versionId), eq(tasks.name, origin.task.name)));

  // The node was deleted in the newer version: its events no longer route anywhere.
  if (!current) return undefined;
  return { workflow: origin.workflow, versionId, task: current };
}

/**
 * `workflows.current_version_id` when the graph editor has set it, newest row otherwise —
 * so a version published without touching the pointer still routes.
 */
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

/**
 * Creates one `queued` run, guarded by the two things that must happen *before* any work:
 * the loop budget (§5) and the `(task, event)` dedupe claim (§6).
 *
 * The claim and the run insert share one transaction, and that is load-bearing. Dedupe is
 * what makes at-least-once delivery safe, so a claim that commits without its run would
 * turn every redelivery into a `duplicate` and lose the trigger for good. Together they are
 * atomic: either the event is claimed *and* has its run, or neither, and it is redelivered.
 *
 * Hop checks precede admission. Rejected deliveries are claimed with their budget notice
 * so redelivery cannot multiply notices; run-count admission shares the run transaction.
 */
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

  // The run this event triggers becomes hop N+1, so the budget is spent when the trigger's
  // own chain already fills it.
  const [execution] = event.executionId
    ? await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, event.executionId))
    : [];
  const maxHops = execution?.maxHops ?? workflow.maxHops;
  const depth = await chainDepth(db, event.eventId, maxHops + 1);
  if (depth > maxHops) {
    if ([LOOP_BUDGET_EXCEEDED, RUN_BUDGET_EXCEEDED].includes(event.type)) return undefined;
    await db.transaction(async (trx) => {
      if ((await claim(trx, task.id, event.eventId)) === "duplicate") return;
      await publish(trx, {
        type: LOOP_BUDGET_EXCEEDED,
        sourceTaskId: task.id,
        causationId: event.eventId,
        executionId: event.executionId,
        packet: { taskId: task.id, workflowId: workflow.id, maxHops, depth },
      });
    });
    return undefined;
  }

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
