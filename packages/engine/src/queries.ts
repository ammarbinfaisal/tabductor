import { chainOf } from "@tabductor/bus";
import {
  events,
  runs,
  tasks,
  workflowVersions,
  workflows,
  type Db,
  type EventRow,
  type RunRow,
  type TaskRow,
  type WorkflowRow,
} from "@tabductor/db";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

/**
 * Read models for the control plane (S2c). They live beside the engine rather than in the
 * Next.js app because the shapes are the engine's — a router that hand-rolled these joins
 * would be a second, drifting description of the same data.
 *
 * Every list is keyset-paginated. `createdAt DESC, id DESC` is the order and also the
 * cursor: OFFSET on a table the engine is actively appending to skips rows.
 */

export const PAGE_LIMIT = { min: 1, max: 200, default: 50 } as const;

export type Page<T> = { items: T[]; nextCursor: string | null };

/** `<epoch millis>|<row id>` — opaque to the client, cheap to compare, stable under inserts. */
function encodeCursor(at: Date, id: string): string {
  return `${at.getTime()}|${id}`;
}

function decodeCursor(cursor: string | null | undefined): { at: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [millis, ...rest] = cursor.split("|");
  const at = Number(millis);
  const id = rest.join("|");
  return Number.isFinite(at) && id ? { at: new Date(at), id } : undefined;
}

function pageOf<T extends { createdAt: Date; id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export type WorkflowSummary = WorkflowRow & {
  taskCount: number;
  lastRunStatus: string | null;
  lastRunAt: Date | null;
};

/**
 * The workflow list, with the two numbers the index page shows. Both are correlated
 * subqueries against the *current* version, so a workflow with fifty archived versions
 * still reports the graph you would open.
 */
export async function listWorkflows(db: Db, userId?: string): Promise<WorkflowSummary[]> {
  const rows = await db
    // Table and column names are written out rather than interpolated: drizzle renders a
    // column reference inside a select-list `sql` template unqualified, and a bare `id`
    // next to the subquery's own `runs r` is ambiguous to Postgres.
    .select({
      workflow: workflows,
      taskCount: sql<number>`(
        select count(*)::int from tasks t
        where t.workflow_version_id = workflows.current_version_id
      )`,
      lastRunStatus: sql<string | null>`(
        select r.status from runs r
        join workflow_versions v on v.id = r.workflow_version_id
        where v.workflow_id = workflows.id
        order by r.created_at desc, r.id desc limit 1
      )`,
      lastRunAt: sql<Date | null>`(
        select r.created_at from runs r
        join workflow_versions v on v.id = r.workflow_version_id
        where v.workflow_id = workflows.id
        order by r.created_at desc, r.id desc limit 1
      )`,
    })
    .from(workflows)
    .where(userId ? eq(workflows.userId, userId) : undefined)
    .orderBy(desc(workflows.createdAt), desc(workflows.id));

  return rows.map((r) => ({
    ...r.workflow,
    taskCount: r.taskCount,
    lastRunStatus: r.lastRunStatus,
    lastRunAt: r.lastRunAt === null ? null : new Date(r.lastRunAt),
  }));
}

export async function getWorkflow(db: Db, workflowId: string): Promise<WorkflowRow | undefined> {
  const [row] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
  return row;
}

export type TaskSummary = { id: string; name: string; mode: string };

export async function getTask(db: Db, taskId: string): Promise<TaskRow | undefined> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row;
}

/** Tasks of a version, for the runs/events filters and the trigger panel's task picker. */
export async function listVersionTasks(db: Db, versionId: string): Promise<TaskSummary[]> {
  return db
    .select({ id: tasks.id, name: tasks.name, mode: tasks.mode })
    .from(tasks)
    .where(eq(tasks.workflowVersionId, versionId))
    .orderBy(tasks.name);
}

export type RunListInput = {
  workflowId?: string;
  taskId?: string;
  status?: string;
  cursor?: string | null;
  limit?: number;
};

export type RunListItem = RunRow & { taskName: string; workflowId: string };

export async function listRuns(db: Db, input: RunListInput): Promise<Page<RunListItem>> {
  const limit = input.limit ?? PAGE_LIMIT.default;
  const after = decodeCursor(input.cursor);

  const rows = await db
    .select({ run: runs, taskName: tasks.name, workflowId: workflowVersions.workflowId })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(
      and(
        input.workflowId ? eq(workflowVersions.workflowId, input.workflowId) : undefined,
        input.taskId ? eq(runs.taskId, input.taskId) : undefined,
        input.status ? eq(runs.status, input.status) : undefined,
        after ? sql`(${runs.createdAt}, ${runs.id}) < (${after.at}, ${after.id})` : undefined,
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit + 1);

  return pageOf(
    rows.map((r) => ({ ...r.run, taskName: r.taskName, workflowId: r.workflowId })),
    limit,
  );
}

export type RunDetail = { run: RunRow; task: TaskSummary; trigger: EventRow | null };

export async function getRun(db: Db, runId: string): Promise<RunDetail | undefined> {
  const [row] = await db
    .select({ run: runs, id: tasks.id, name: tasks.name, mode: tasks.mode })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId));
  if (!row) return undefined;

  const trigger = row.run.triggerEventId
    ? ((await db.select().from(events).where(eq(events.eventId, row.run.triggerEventId)))[0] ?? null)
    : null;
  return { run: row.run, task: { id: row.id, name: row.name, mode: row.mode }, trigger };
}

export type EventListInput = {
  workflowId?: string;
  type?: string;
  cursor?: string | null;
  limit?: number;
};

export type EventListItem = EventRow & { sourceTaskName: string | null };

/**
 * The event feed. "Belongs to this workflow" reaches one hop further than the obvious
 * `source_task_id` test: `system.event_dead_lettered` is published with no source task at
 * all, and dropping the very events that say something went wrong out of the debugging feed
 * would be the wrong trade.
 */
export async function listEvents(db: Db, input: EventListInput): Promise<Page<EventListItem>> {
  const limit = input.limit ?? PAGE_LIMIT.default;
  const after = decodeCursor(input.cursor);
  const ofWorkflow = (id: string): SQL => sql`(
    ${events.sourceTaskId} in (
      select t.id from ${tasks} t
      join ${workflowVersions} v on v.id = t.workflow_version_id
      where v.workflow_id = ${id}
    )
    or ${events.causationId} in (
      select e.event_id from ${events} e
      join ${tasks} t on t.id = e.source_task_id
      join ${workflowVersions} v on v.id = t.workflow_version_id
      where v.workflow_id = ${id}
    )
  )`;

  const rows = await db
    .select({ event: events, sourceTaskName: tasks.name })
    .from(events)
    .leftJoin(tasks, eq(tasks.id, events.sourceTaskId))
    .where(
      and(
        input.workflowId ? ofWorkflow(input.workflowId) : undefined,
        input.type ? eq(events.type, input.type) : undefined,
        after ? sql`(${events.occurredAt}, ${events.eventId}) < (${after.at}, ${after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(events.occurredAt), desc(events.eventId))
    .limit(limit + 1);

  // `events` keys on `event_id`/`occurred_at`; the cursor helper wants `id`/`createdAt`.
  const shaped = rows.map((r) => ({
    ...r.event,
    sourceTaskName: r.sourceTaskName,
    id: r.event.eventId,
    createdAt: r.event.occurredAt,
  }));
  const page = pageOf(shaped, limit);
  return {
    items: page.items.map(({ id: _id, createdAt: _createdAt, ...event }) => event),
    nextCursor: page.nextCursor,
  };
}

export type EventDetail = {
  event: EventRow;
  /** Oldest ancestor → this event, the causation breadcrumb the feed renders. */
  lineage: EventRow[];
  /** The runs this event created, so the feed can link forward as well as back. */
  triggered: Array<{ id: string; taskId: string; taskName: string; status: string }>;
};

export async function getEvent(db: Db, eventId: string): Promise<EventDetail | undefined> {
  const lineage = await chainOf(db, eventId);
  const event = lineage.at(-1);
  if (!event) return undefined;

  const triggered = await db
    .select({ id: runs.id, taskId: runs.taskId, taskName: tasks.name, status: runs.status })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.triggerEventId, eventId))
    .orderBy(runs.createdAt);

  return { event, lineage, triggered };
}
