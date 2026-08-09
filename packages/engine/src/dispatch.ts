import { chainDepth, claim, publish } from "@tabductor/bus";
import { newId } from "@tabductor/core";
import {
  edges,
  runs,
  tasks,
  workflowVersions,
  workflows,
  type Db,
  type EventRow,
  type TaskRow,
  type WorkflowRow,
} from "@tabductor/db";
import { and, desc, eq } from "drizzle-orm";

export const LOOP_BUDGET_EXCEEDED = "system.loop_budget_exceeded";

/**
 * Graph evaluation is one function, not a planner: given an event, find the tasks that
 * subscribe to it in the *latest* workflow version, and create one pinned `queued` run per
 * task. Execution is the caller's business.
 */

export type Dispatched = {
  runId: string;
  taskId: string;
  workflowVersionId: string;
};

/**
 * Resolves subscribers and creates their runs. Returns the runs created — never the ones
 * skipped by dedupe or by the loop budget.
 *
 * Routing runs against the workflow's latest version (§5) while each run pins the version
 * it was created under (`runs.workflow_version_id`), so a graph edit mid-flight changes
 * where *future* events go without disturbing runs already executing.
 */
export async function dispatchEvent(db: Db, event: EventRow): Promise<Dispatched[]> {
  const source = await resolveSource(db, event);
  if (!source) return [];

  const subscribers = await db
    .select({ task: tasks })
    .from(edges)
    .innerJoin(tasks, eq(tasks.id, edges.toTaskId))
    .where(
      and(
        eq(edges.workflowVersionId, source.versionId),
        eq(edges.eventType, event.type),
        eq(edges.fromTaskId, source.taskId),
      ),
    );

  const created: Dispatched[] = [];
  for (const { task } of subscribers) {
    const run = await createRun(db, { task, event, workflow: source.workflow, versionId: source.versionId });
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
export async function dispatchToTask(db: Db, taskId: string, event: EventRow): Promise<Dispatched | undefined> {
  const target = await resolveTask(db, taskId);
  if (!target) return undefined;
  return createRun(db, { task: target.task, event, workflow: target.workflow, versionId: target.versionId });
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
  input: { taskId: string; type?: string; packet?: unknown },
): Promise<{ event: EventRow; dispatched: Dispatched | undefined }> {
  const event = await db.transaction((trx) =>
    publish(trx, {
      type: input.type ?? MANUAL_TRIGGER,
      sourceTaskId: input.taskId,
      packet: input.packet ?? {},
    }),
  );
  return { event, dispatched: await dispatchToTask(db, input.taskId, event) };
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
  const resolved = await resolveTask(db, event.sourceTaskId);
  return resolved && { workflow: resolved.workflow, versionId: resolved.versionId, taskId: resolved.task.id };
}

/**
 * A task id from *some* version → the row for the same node in the latest version, with
 * the workflow it belongs to. `undefined` when the node was deleted in a newer version.
 */
async function resolveTask(
  db: Db,
  taskId: string,
): Promise<{ workflow: WorkflowRow; versionId: string; task: TaskRow } | undefined> {
  const [origin] = await db
    .select({ task: tasks, workflow: workflows })
    .from(tasks)
    .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(tasks.id, taskId));
  if (!origin) return undefined;

  const versionId = await latestVersionId(db, origin.workflow);

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
 * The budget check stays outside — it only reads, and it comes first so an over-budget
 * event never burns its claim.
 */
async function createRun(
  db: Db,
  args: { task: TaskRow; event: EventRow; workflow: WorkflowRow; versionId: string },
): Promise<Dispatched | undefined> {
  const { task, event, workflow, versionId } = args;

  // The run this event triggers becomes hop N+1, so the budget is spent when the trigger's
  // own chain already fills it.
  const depth = await chainDepth(db, event.eventId, workflow.maxHops + 1);
  if (depth > workflow.maxHops) {
    await db.transaction((trx) =>
      publish(trx, {
        type: LOOP_BUDGET_EXCEEDED,
        sourceTaskId: task.id,
        causationId: event.eventId,
        packet: { taskId: task.id, workflowId: workflow.id, maxHops: workflow.maxHops, depth },
      }),
    );
    return undefined;
  }

  const runId = newId("run");
  const created = await db.transaction(async (trx) => {
    if ((await claim(trx, task.id, event.eventId)) === "duplicate") return false;
    await trx.insert(runs).values({
      id: runId,
      taskId: task.id,
      workflowVersionId: versionId,
      triggerEventId: event.eventId,
      status: "queued",
      modeUsed: task.mode,
    });
    return true;
  });

  return created ? { runId, taskId: task.id, workflowVersionId: versionId } : undefined;
}
