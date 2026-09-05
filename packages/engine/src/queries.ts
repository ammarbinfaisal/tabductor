import { AppError, newId } from "@tabductor/core";
import { chainOf } from "@tabductor/bus";
import {
  cdpEndpoints,
  engineStatus,
  events,
  runs,
  tasks,
  traceEntries,
  workflowVersions,
  workflows,
  type CdpEndpointRow,
  type Db,
  type EventRow,
  type RunRow,
  type RunStatus,
  type TaskRow,
  type TraceEntryRow,
  type WorkflowRow,
} from "@tabductor/db";
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";

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

export function decodeCursor(cursor: string | null | undefined): { at: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [millis, ...rest] = cursor.split("|");
  const at = Number(millis);
  const id = rest.join("|");
  return Number.isFinite(at) && id ? { at: new Date(at), id } : undefined;
}

/**
 * Trim an over-fetched page to `limit` and turn the last surviving row into the next cursor.
 *
 * `keyOf` names the sort key rather than requiring the row to be shaped `{createdAt, id}` —
 * `events` sorts on `occurred_at`/`event_id`, and demanding the one shape made both event
 * readers rename their columns on the way in and strip the aliases on the way out.
 */
export function pageOf<T>(rows: T[], limit: number, keyOf: (row: T) => { at: Date; id: string }): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  if (!(rows.length > limit && last)) return { items, nextCursor: null };
  const key = keyOf(last);
  return { items, nextCursor: encodeCursor(key.at, key.id) };
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
    // Table and column names are written out rather than interpolated (`${workflows.id}`),
    // and the reason is specific enough to be worth stating.
    //
    // drizzle's `buildSelection` computes `isSingleTable = !joins || joins.length === 0`,
    // and when it is true it rewrites every column chunk inside a select-list `sql` template
    // to a bare identifier — dropping the table qualifier. That is right for a flat
    // projection (`select "id" from "workflows"`) and wrong for a correlated subquery, which
    // brings its own FROM scope: a bare `"id"` beside `runs r` and `workflow_versions v` is
    // ambiguous, and Postgres rejects the statement.
    //
    // The `no joins` half is the trap. `listRuns` and `listEvents` interpolate columns the
    // same way and are fine, because they join and so keep their qualifiers — which is why
    // this failed only here, and only once a page actually called it.
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

/**
 * `mode` here is the **row's** mode — `compiled` when the engine promoted the task — unlike
 * `readGraph`, which hands the editor the authored `ai` back. `compiledPrompt` is the
 * internal prompt publish compiled for the node; shown read-only, never edited.
 */
export type TaskSummary = { id: string; name: string; kind: string; mode: string; compiledPrompt: string | null };

export async function getTask(db: Db, taskId: string): Promise<TaskRow | undefined> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row;
}

/** Tasks of a version, for the runs/events filters and the trigger panel's task picker. */
export async function listVersionTasks(db: Db, versionId: string): Promise<TaskSummary[]> {
  return db
    .select({ id: tasks.id, name: tasks.name, kind: tasks.kind, mode: tasks.mode, compiledPrompt: tasks.compiledPrompt })
    .from(tasks)
    .where(eq(tasks.workflowVersionId, versionId))
    .orderBy(tasks.name);
}

/**
 * Optional fields are written `?: T | undefined` throughout this file, not `?: T`. Under
 * `exactOptionalPropertyTypes` the second forbids passing an explicit `undefined`, which
 * turns every caller holding an optional value into a `...(x === undefined ? {} : { x })`
 * spread. The property means the same thing either way; only the call sites differ.
 */
export type RunListInput = {
  workflowId?: string | undefined;
  taskId?: string | undefined;
  status?: RunStatus | undefined;
  cursor?: string | null | undefined;
  limit?: number | undefined;
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
    (r) => ({ at: r.createdAt, id: r.id }),
  );
}

export type RunDetail = { run: RunRow; task: TaskSummary; trigger: EventRow | null };

export async function getRun(db: Db, runId: string): Promise<RunDetail | undefined> {
  const [row] = await db
    .select({ run: runs, id: tasks.id, name: tasks.name, kind: tasks.kind, mode: tasks.mode, compiledPrompt: tasks.compiledPrompt })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId));
  if (!row) return undefined;

  const trigger = row.run.triggerEventId
    ? ((await db.select().from(events).where(eq(events.eventId, row.run.triggerEventId)))[0] ?? null)
    : null;
  return {
    run: row.run,
    task: { id: row.id, name: row.name, kind: row.kind, mode: row.mode, compiledPrompt: row.compiledPrompt },
    trigger,
  };
}

export type EventListInput = {
  workflowId?: string | undefined;
  type?: string | undefined;
  cursor?: string | null | undefined;
  limit?: number | undefined;
};

export type EventListItem = EventRow & { sourceTaskName: string | null };

/**
 * The event feed. "Belongs to this workflow" reaches one hop further than the obvious
 * `source_task_id` test: `system.event_dead_lettered` is published with no source task at
 * all, and dropping the very events that say something went wrong out of the debugging feed
 * would be the wrong trade.
 */
export function eventOfWorkflow(id: string): SQL {
  return sql`(
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
}

export async function listEvents(db: Db, input: EventListInput): Promise<Page<EventListItem>> {
  const limit = input.limit ?? PAGE_LIMIT.default;
  const after = decodeCursor(input.cursor);

  const rows = await db
    .select({ event: events, sourceTaskName: tasks.name })
    .from(events)
    .leftJoin(tasks, eq(tasks.id, events.sourceTaskId))
    .where(
      and(
        input.workflowId ? eventOfWorkflow(input.workflowId) : undefined,
        input.type ? eq(events.type, input.type) : undefined,
        after ? sql`(${events.occurredAt}, ${events.eventId}) < (${after.at}, ${after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(events.occurredAt), desc(events.eventId))
    .limit(limit + 1);

  return pageOf(
    rows.map((r) => ({ ...r.event, sourceTaskName: r.sourceTaskName })),
    limit,
    (r) => ({ at: r.occurredAt, id: r.eventId }),
  );
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

/**
 * The run inspector's timeline (U1.5). Forward paged by `seq` — the writer's own ordering
 * (`createTraceRecorder`), not `created_at`: a buffered flush can land several entries in
 * one millisecond, so `seq` is the only column that is actually monotonic within a run.
 *
 * The cursor is the last-returned `seq`, not the composite `<at>|<id>` codec the other
 * lists use — a trace entry has no id of its own, and `(run_id, seq)` is already the whole
 * key, so a second field would encode nothing `seq` doesn't.
 */
export type TraceListInput = {
  runId: string;
  cursor?: string | null | undefined;
  limit?: number | undefined;
};

export type TraceEntryItem = Omit<TraceEntryRow, "runId">;

export async function listTraceEntries(db: Db, input: TraceListInput): Promise<Page<TraceEntryItem>> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? PAGE_LIMIT.default), PAGE_LIMIT.min), PAGE_LIMIT.max);
  const after = input.cursor ? Number(input.cursor) : undefined;
  const afterSeq = after !== undefined && Number.isFinite(after) ? after : undefined;

  const rows = await db
    .select({
      seq: traceEntries.seq,
      kind: traceEntries.kind,
      payloadJson: traceEntries.payloadJson,
      blobRef: traceEntries.blobRef,
      createdAt: traceEntries.createdAt,
    })
    .from(traceEntries)
    .where(and(eq(traceEntries.runId, input.runId), afterSeq !== undefined ? gt(traceEntries.seq, afterSeq) : undefined))
    .orderBy(asc(traceEntries.seq))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? String(items.at(-1)!.seq) : null;
  return { items, nextCursor };
}

/**
 * Endpoint health (U1.5, `cdp_endpoints`). `ws_url` is a bearer credential (techical_plan
 * §16 Threat 5) and is filtered out **here, in the column list** — never selected, so no
 * router or component bug downstream can leak it. Deleting the field from a fetched row
 * would still let a stray `select()` upstream pull it into a log or a wider payload.
 */
export type CdpEndpointSummary = Omit<CdpEndpointRow, "wsUrl" | "userId">;

const ENDPOINT_SUMMARY = {
  id: cdpEndpoints.id,
  workflowId: cdpEndpoints.workflowId,
  label: cdpEndpoints.label,
  healthy: cdpEndpoints.healthy,
  lastCheckedAt: cdpEndpoints.lastCheckedAt,
  maxQueueDepth: cdpEndpoints.maxQueueDepth,
  position: cdpEndpoints.position,
  lastAcquiredAt: cdpEndpoints.lastAcquiredAt,
  createdAt: cdpEndpoints.createdAt,
} as const;

export async function listCdpEndpoints(db: Db): Promise<CdpEndpointSummary[]> {
  return db.select(ENDPOINT_SUMMARY).from(cdpEndpoints).orderBy(desc(cdpEndpoints.createdAt));
}

// -- U3a: per-workflow endpoints + rotation ----------------------------------------------
//
// A workflow owns an ordered list of CDP endpoints (its "Browser endpoints" setting) and its
// browser runs rotate across them. There is deliberately no global default any more: the
// engine used to bind `(browser, ai)` to the oldest row in the table at boot, which meant
// every workflow drove the same browser and adding a second one changed nothing.

export async function listWorkflowEndpoints(db: Db, workflowId: string): Promise<CdpEndpointSummary[]> {
  return db
    .select(ENDPOINT_SUMMARY)
    .from(cdpEndpoints)
    .where(eq(cdpEndpoints.workflowId, workflowId))
    .orderBy(asc(cdpEndpoints.position), asc(cdpEndpoints.createdAt));
}

export type AddWorkflowEndpointInput = { workflowId: string; wsUrl: string; label?: string | undefined };

/** Appends to the workflow's list. `ws_url` goes in and never comes back out (Threat 5). */
export async function addWorkflowEndpoint(db: Db, input: AddWorkflowEndpointInput): Promise<CdpEndpointSummary> {
  const [wf] = await db.select({ userId: workflows.userId }).from(workflows).where(eq(workflows.id, input.workflowId)).limit(1);
  if (!wf) throw new AppError("workflow_not_found", `no workflow ${input.workflowId}`, { details: { workflowId: input.workflowId } });
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${cdpEndpoints.position}), -1) + 1` })
    .from(cdpEndpoints)
    .where(eq(cdpEndpoints.workflowId, input.workflowId));
  const [row] = await db
    .insert(cdpEndpoints)
    .values({
      id: newId("cdp"),
      userId: wf.userId,
      workflowId: input.workflowId,
      wsUrl: input.wsUrl,
      label: input.label ?? null,
      position: Number(next),
    })
    .returning(ENDPOINT_SUMMARY);
  return row!;
}

export type UpdateWorkflowEndpointInput = {
  workflowId: string;
  id: string;
  wsUrl?: string | undefined;
  label?: string | null | undefined;
};

/**
 * Edits an endpoint in place, keeping its id, position, and lease.
 *
 * Editing rather than remove-and-re-add because the two are not equivalent: re-adding
 * appends to the end of the list, and the list's order is the rotation order the engine
 * spreads runs across — so fixing a typo would silently demote the endpoint to last. An
 * omitted field is left alone; `label: null` clears it, which is why the type distinguishes
 * `null` from `undefined`.
 *
 * `healthy` is reset to true on a URL change: the old value is a verdict about an address
 * that is no longer the one stored, and leaving it false would keep an endpoint the user
 * just repaired looking broken until something happened to reconnect it.
 */
export async function updateWorkflowEndpoint(
  db: Db,
  input: UpdateWorkflowEndpointInput,
): Promise<CdpEndpointSummary | null> {
  const patch: Record<string, unknown> = {};
  if (input.wsUrl !== undefined) {
    patch.wsUrl = input.wsUrl;
    patch.healthy = true;
    patch.lastCheckedAt = null;
  }
  if (input.label !== undefined) patch.label = input.label;
  if (Object.keys(patch).length === 0) {
    const [row] = await db
      .select(ENDPOINT_SUMMARY)
      .from(cdpEndpoints)
      .where(and(eq(cdpEndpoints.id, input.id), eq(cdpEndpoints.workflowId, input.workflowId)));
    return row ?? null;
  }
  const [row] = await db
    .update(cdpEndpoints)
    .set(patch)
    .where(and(eq(cdpEndpoints.id, input.id), eq(cdpEndpoints.workflowId, input.workflowId)))
    .returning(ENDPOINT_SUMMARY);
  return row ?? null;
}

export async function removeWorkflowEndpoint(db: Db, input: { workflowId: string; id: string }): Promise<boolean> {
  const deleted = await db
    .delete(cdpEndpoints)
    .where(and(eq(cdpEndpoints.id, input.id), eq(cdpEndpoints.workflowId, input.workflowId)))
    .returning({ id: cdpEndpoints.id });
  return deleted.length > 0;
}

/** `ids` in the wanted order; ids not in the workflow's list are ignored, missing ones keep
 * their relative order after the given ones. */
export async function reorderWorkflowEndpoints(db: Db, input: { workflowId: string; ids: string[] }): Promise<void> {
  await db.transaction(async (trx) => {
    const current = await trx
      .select({ id: cdpEndpoints.id })
      .from(cdpEndpoints)
      .where(eq(cdpEndpoints.workflowId, input.workflowId))
      .orderBy(asc(cdpEndpoints.position), asc(cdpEndpoints.createdAt));
    const known = new Set(current.map((r) => r.id));
    const ordered = [...input.ids.filter((id) => known.has(id)), ...current.map((r) => r.id).filter((id) => !input.ids.includes(id))];
    for (const [position, id] of ordered.entries()) {
      await trx.update(cdpEndpoints).set({ position }).where(eq(cdpEndpoints.id, id));
    }
  });
}

/**
 * The rotation. Picks the workflow's healthy endpoint that was acquired longest ago (never
 * acquired first; ties by `position`) and stamps `last_acquired_at` in the same statement,
 * so two runs of the same workflow starting together take different endpoints. Per-endpoint
 * serialization (`endpoint_leases`, S3b) still applies underneath — this chooses *which*
 * browser, the pool decides *when*.
 *
 * No endpoints → `no_endpoint_configured`, which the executors fail **permanently**: a retry
 * cannot change a setting.
 */
export async function pickWorkflowEndpoint(db: Db, workflowId: string): Promise<string> {
  const candidate = db
    .select({ id: cdpEndpoints.id })
    .from(cdpEndpoints)
    .where(and(eq(cdpEndpoints.workflowId, workflowId), eq(cdpEndpoints.healthy, true)))
    .orderBy(sql`${cdpEndpoints.lastAcquiredAt} asc nulls first`, asc(cdpEndpoints.position), asc(cdpEndpoints.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });
  const [picked] = await db
    .update(cdpEndpoints)
    .set({ lastAcquiredAt: sql`now()` })
    .where(inArray(cdpEndpoints.id, candidate))
    .returning({ id: cdpEndpoints.id });
  if (picked) return picked.id;
  const [any] = await db
    .select({ id: cdpEndpoints.id })
    .from(cdpEndpoints)
    .where(and(eq(cdpEndpoints.workflowId, workflowId), eq(cdpEndpoints.healthy, true)))
    .limit(1);
  if (any) {
    // Every healthy endpoint is mid-pick by a concurrent run; fall back to the plain LRU
    // order without the lock — the pool serializes actual use anyway.
    const [row] = await db
      .update(cdpEndpoints)
      .set({ lastAcquiredAt: sql`now()` })
      .where(eq(cdpEndpoints.id, any.id))
      .returning({ id: cdpEndpoints.id });
    return row!.id;
  }
  throw new AppError("no_endpoint_configured", "this workflow has no healthy browser endpoint configured", {
    details: { workflowId },
  });
}

/** Workflow id for a task's pinned version — what `pickWorkflowEndpoint` needs. */
export async function workflowIdForVersion(db: Db, workflowVersionId: string): Promise<string> {
  const [row] = await db
    .select({ workflowId: workflowVersions.workflowId })
    .from(workflowVersions)
    .where(eq(workflowVersions.id, workflowVersionId))
    .limit(1);
  if (!row) {
    throw new AppError("task_workflow_not_found", `no workflow found for workflow_version ${workflowVersionId}`, {
      details: { workflowVersionId },
    });
  }
  return row.workflowId;
}

// -- U3a: engine status ---------------------------------------------------------------------

export const ENGINE_STATUS_ID = "engine";
/** A heartbeat older than this means the engine is down (the watchdog ticks every 250ms). */
export const ENGINE_STALE_MS = 15_000;

/** `capabilities`: tool-level abilities that are not a `(kind, mode)` pair — `"python.run"`
 * when a `PYRUNNER_URL` is configured. The editor reads it to say what an asset node can do. */
export async function recordEngineBoot(db: Db, executors: string[], capabilities: string[] = []): Promise<void> {
  await db
    .insert(engineStatus)
    .values({ id: ENGINE_STATUS_ID, executors, capabilities, bootedAt: sql`now()`, heartbeatAt: sql`now()` })
    .onConflictDoUpdate({
      target: engineStatus.id,
      set: { executors, capabilities, bootedAt: sql`now()`, heartbeatAt: sql`now()` },
    });
}

export async function touchEngineHeartbeat(db: Db): Promise<void> {
  await db.update(engineStatus).set({ heartbeatAt: sql`now()` }).where(eq(engineStatus.id, ENGINE_STATUS_ID));
}

export type EngineStatusView = {
  executors: string[];
  capabilities: string[];
  bootedAt: Date | null;
  heartbeatAt: Date | null;
  stale: boolean;
};

export async function getEngineStatus(db: Db, now: Date = new Date()): Promise<EngineStatusView> {
  const [row] = await db.select().from(engineStatus).where(eq(engineStatus.id, ENGINE_STATUS_ID)).limit(1);
  if (!row) return { executors: [], capabilities: [], bootedAt: null, heartbeatAt: null, stale: true };
  return {
    executors: row.executors,
    capabilities: row.capabilities,
    bootedAt: row.bootedAt,
    heartbeatAt: row.heartbeatAt,
    stale: now.getTime() - row.heartbeatAt.getTime() > ENGINE_STALE_MS,
  };
}

/**
 * A `RunHandle` carries `task.workflow_version_id`, not `user_id` directly — every per-user
 * lookup a `mode=ai` executor needs (the MCP server list for `AssetExecutor`, the asset-store
 * namespace `page.upload` resolves an asset ref against for `AgentExecutor`, S5f) makes this
 * exact join, so it lives here once rather than once per executor (`asset-executor.ts` was
 * S5c's only caller before S5f gave the browser executor a second reason to need it).
 * `packages/secrets/src/broker.ts`'s `resolveSecretForRun` makes the identical join for the
 * identical reason.
 *
 * Lives here rather than in `packages/agent` because S5h's `PythonExecutor` needs it too and
 * `packages/engine` cannot import `packages/agent` — agent already imports engine. Moving it
 * down leaves one copy, not two; `executor-shared.ts` re-exports it so every existing call
 * site is unchanged.
 */
export async function userIdForTask(db: Db, workflowVersionId: string): Promise<string> {
  const rows = await db
    .select({ userId: workflows.userId })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(workflowVersions.id, workflowVersionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new AppError("task_workflow_not_found", `no workflow found for workflow_version ${workflowVersionId}`, {
      details: { workflowVersionId },
    });
  }
  return row.userId;
}
