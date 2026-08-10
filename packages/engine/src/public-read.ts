import { chainIdsOf } from "@tabductor/bus";
import {
  edges,
  eventDefs,
  events,
  runs,
  schedules,
  tasks,
  workflowVersions,
  type Db,
  type MissedPolicy,
  type OverlapPolicy,
  type RunStatus,
} from "@tabductor/db";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { NODE_KINDS, type NodeKind } from "./graph.js";
import { decodeCursor, eventOfWorkflow, pageOf, PAGE_LIMIT, type Page } from "./queries.js";
import type { RefCodec } from "./shares.js";

/**
 * The public read models (S2d, `docs/sharing.md` §4).
 *
 * They live in their own file because the rule they encode is a boundary rather than a
 * grouping: **these queries filter in SQL and never widen.** A private packet is not
 * fetched and then dropped — it is never selected, so a bug in a router, a serializer or a
 * component cannot leak one. Fetch-then-redact would put that property in the layer most
 * likely to be refactored by someone who does not know it is load-bearing.
 *
 * Three consequences worth stating, because each is easy to undo by accident:
 *
 * 1. Every function takes a **required** `workflowId`. Nothing here accepts an optional
 *    owner filter the way `listWorkflows` does — that function returns the whole database
 *    when its argument is omitted, and this path must not be able to reach anything shaped
 *    like it.
 * 2. Nothing returns a raw row id. Callers pass a `RefCodec`, so the results carry
 *    share-scoped opaque refs and there is no id in the shape at all to forget to strip.
 * 3. Nothing returns `runs.error`, task prompts or `limits_json`. Free text is where
 *    content leaks back in through a channel nobody thought of as a channel.
 */

/**
 * The read scope: which workflow, under which share, showing which packets. One object
 * rather than three arguments, because it is the thing a caller must not assemble
 * partially — a `workflowId` without a `publicTypes` is how every packet becomes readable.
 *
 * `publicRunList` does not consult `publicTypes` today; it takes the same scope anyway, so
 * there is no shape in this file that a caller can construct half of.
 */
export type PublicRead = {
  workflowId: string;
  ref: RefCodec;
  publicTypes: ReadonlySet<string>;
};

/**
 * `runs.error` is executor-authored free text — a stub's message today, a Python traceback
 * or a page snippet later — so the public view gets a bounded class instead (sharing.md
 * §3.3). A bounded set is safe to render precisely because it cannot carry content.
 *
 * Named as a union, not left as `string`, because "bounded" is the whole property: a viewer
 * of this type can switch on it exhaustively, and a class added to the CASE below without a
 * matching member here fails to compile rather than reaching the page as an unknown label.
 */
export const PUBLIC_ERROR_CLASSES = [
  "timeout",
  "cancelled",
  "engine_restart",
  "no_executor",
  "packet_invalid",
  "other",
] as const;
export type PublicErrorClass = (typeof PUBLIC_ERROR_CLASSES)[number];

/**
 * Derived in SQL from status first and the string only where status cannot tell them apart.
 * Adding a class is a deliberate act: the point of `other` is that an unrecognised message
 * degrades to a label rather than to its text.
 */
const ERROR_CLASS: SQL<PublicErrorClass | null> = sql`
  case
    when ${runs.status} = 'timed_out' then 'timeout'
    when ${runs.status} = 'cancelled' then 'cancelled'
    when ${runs.error} is null then null
    when ${runs.error} = 'engine_restart' then 'engine_restart'
    when ${runs.error} like 'no executor registered%' then 'no_executor'
    when ${runs.error} like 'packet failed schema%'
      or ${runs.error} like 'task declares no event_def%'
      or ${runs.error} like 'event_def %malformed packet schema' then 'packet_invalid'
    else 'other'
  end
`;

export type PublicGraphTask = {
  name: string;
  kind: NodeKind;
  /** Open by design (`stub`, then `ai`/`compiled`/`python`) — not a closed domain to narrow. */
  mode: string;
  position: { x: number; y: number } | null;
  /** `packetSchema` is present only for a public type — the fields are part of the manifest. */
  emits: Array<{ type: string; public: boolean; packetSchema?: Record<string, unknown> }>;
  schedule: {
    cron: string;
    tz: string;
    missedPolicy: MissedPolicy;
    overlapPolicy: OverlapPolicy;
    enabled: boolean;
  } | null;
};

export type PublicGraph = {
  tasks: PublicGraphTask[];
  edges: Array<{ from: string; eventType: string; to: string }>;
};

/**
 * The graph as a viewer sees it: shape, kinds, modes, schedules and which events are
 * shared. Not `readGraph` with fields removed — that would select prompts and limits.
 *
 * `kind` and `position` have no columns yet (they arrive with S5a), so they come from
 * `graph_json`. That document also holds prompts and stub scripts, so it is projected
 * **in Postgres** down to the two keys this needs rather than parsed here and picked over.
 */
export async function publicGraph(db: Db, input: { versionId: string }): Promise<PublicGraph> {
  const decorationRows = await db.execute<{ decoration: Record<string, { kind?: string; position?: unknown }> }>(sql`
    select coalesce(
      (
        select jsonb_object_agg(t->>'name', jsonb_build_object('kind', t->'kind', 'position', t->'position'))
        from jsonb_array_elements(${workflowVersions.graphJson} -> 'tasks') t
        where jsonb_typeof(t->'name') = 'string'
      ),
      '{}'::jsonb
    ) as decoration
    from ${workflowVersions}
    where ${workflowVersions.id} = ${input.versionId}
  `);
  const decoration = decorationRows.rows[0]?.decoration ?? {};

  const taskRows = await db
    .select({ id: tasks.id, name: tasks.name, mode: tasks.mode })
    .from(tasks)
    .where(eq(tasks.workflowVersionId, input.versionId))
    .orderBy(asc(tasks.name));
  const taskIds = taskRows.map((t) => t.id);

  // The packet schema is selected only where the type is public — same rule as packets.
  // A drizzle select rather than `db.execute`: the conditional projection is the only part
  // that needs raw SQL, and hand-writing the rest would mean hand-asserting its row type.
  const defRows = taskIds.length
    ? await db
        .select({
          taskId: eventDefs.taskId,
          eventType: eventDefs.eventType,
          public: eventDefs.public,
          packetSchema: sql<unknown>`case when ${eventDefs.public} then ${eventDefs.packetSchemaJson} else null end`,
        })
        .from(eventDefs)
        .where(inArray(eventDefs.taskId, taskIds))
        .orderBy(asc(eventDefs.eventType))
    : [];

  const scheduleRows = taskIds.length
    ? await db
        .select({
          taskId: schedules.taskId,
          cron: schedules.cron,
          tz: schedules.tz,
          missedPolicy: schedules.missedPolicy,
          overlapPolicy: schedules.overlapPolicy,
          enabled: schedules.enabled,
        })
        .from(schedules)
        .where(inArray(schedules.taskId, taskIds))
    : [];
  const scheduleOf = new Map(scheduleRows.map((s) => [s.taskId, s]));

  const edgeRows = await db
    .select({ fromTaskId: edges.fromTaskId, eventType: edges.eventType, toTaskId: edges.toTaskId })
    .from(edges)
    .where(eq(edges.workflowVersionId, input.versionId));
  const nameOf = new Map(taskRows.map((t) => [t.id, t.name]));

  return {
    tasks: taskRows.map((row) => {
      const schedule = scheduleOf.get(row.id);
      const decorated = decoration[row.name];
      return {
        name: row.name,
        kind: isNodeKind(decorated?.kind) ? decorated.kind : "browser",
        mode: row.mode,
        position: isPosition(decorated?.position) ? decorated.position : null,
        emits: defRows
          .filter((d) => d.taskId === row.id)
          .map((d) => ({
            type: d.eventType,
            public: d.public,
            ...(d.public && isRecord(d.packetSchema) ? { packetSchema: d.packetSchema } : {}),
          })),
        schedule: schedule
          ? {
              cron: schedule.cron,
              tz: schedule.tz,
              missedPolicy: schedule.missedPolicy,
              overlapPolicy: schedule.overlapPolicy,
              enabled: schedule.enabled,
            }
          : null,
      };
    }),
    edges: edgeRows.flatMap((e) => {
      const from = e.fromTaskId && nameOf.get(e.fromTaskId);
      const to = nameOf.get(e.toTaskId);
      return from && to ? [{ from, eventType: e.eventType, to }] : [];
    }),
  };
}

export type PublicRun = {
  ref: string;
  taskName: string;
  status: RunStatus;
  mode: string;
  attempt: number;
  errorClass: PublicErrorClass | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
};

export async function publicRunList(
  db: Db,
  input: PublicRead & { cursor?: string | null | undefined; limit?: number | undefined },
): Promise<Page<PublicRun>> {
  const limit = clampLimit(input.limit);
  const after = decodeCursor(input.cursor);

  const rows = await db
    .select({
      id: runs.id,
      taskName: tasks.name,
      status: runs.status,
      mode: runs.modeUsed,
      attempt: runs.attempt,
      errorClass: ERROR_CLASS,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(
      and(
        eq(workflowVersions.workflowId, input.workflowId),
        after ? sql`(${runs.createdAt}, ${runs.id}) < (${after.at}, ${after.id})` : undefined,
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit + 1);

  const page = pageOf(rows, limit, (r) => ({ at: r.createdAt, id: r.id }));
  return {
    items: page.items.map(({ id, ...run }) => ({ ...run, ref: input.ref.encode(id) })),
    nextCursor: page.nextCursor,
  };
}

export type PublicRunDetail = {
  run: PublicRun;
  /** What started it — a schedule fire, a manual trigger, or an upstream node's event. */
  trigger: PublicEvent | null;
  /** What it emitted, so a run reads forward as well as back. */
  emitted: PublicEvent[];
};

export async function publicRunGet(
  db: Db,
  input: PublicRead & { runId: string },
): Promise<PublicRunDetail | undefined> {
  const [row] = await db
    .select({
      id: runs.id,
      taskName: tasks.name,
      status: runs.status,
      mode: runs.modeUsed,
      attempt: runs.attempt,
      errorClass: ERROR_CLASS,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      // Internal only: used to fetch the trigger below, never returned.
      triggerEventId: runs.triggerEventId,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(and(eq(runs.id, input.runId), eq(workflowVersions.workflowId, input.workflowId)));
  if (!row) return undefined;

  const { id, triggerEventId, ...run } = row;
  const related = await selectPublicEvents(
    db,
    input.publicTypes,
    and(
      eventOfWorkflow(input.workflowId),
      triggerEventId
        ? sql`(${events.sourceRunId} = ${input.runId} or ${events.eventId} = ${triggerEventId}::uuid)`
        : eq(events.sourceRunId, input.runId),
    ),
  );

  const shaped = related.map((r) => ({ row: r, shaped: shapeEvent(r, r.id, input.ref) }));
  return {
    run: { ...run, ref: input.ref.encode(id) },
    trigger: shaped.find((s) => s.row.id === triggerEventId)?.shaped ?? null,
    emitted: shaped
      .filter((s) => s.row.id !== triggerEventId)
      .sort((a, b) => a.row.occurredAt.getTime() - b.row.occurredAt.getTime())
      .map((s) => s.shaped),
  };
}

export type PublicEvent = {
  ref: string;
  type: string;
  sourceTaskName: string | null;
  occurredAt: Date;
  /** True when this type is in the manifest. The packet is present only then. */
  packetPublic: boolean;
  packet?: unknown;
};

/**
 * The event feed. The packet column is selected conditionally, in SQL — this is the query
 * the whole feature's safety rests on, and the system test asserts on *its result*, not on
 * an HTTP response, because a fetch-then-redact implementation would pass the latter.
 */
export async function publicEventList(
  db: Db,
  input: PublicRead & { cursor?: string | null | undefined; limit?: number | undefined },
): Promise<Page<PublicEvent>> {
  const limit = clampLimit(input.limit);
  const after = decodeCursor(input.cursor);
  const isPublic = publicTypePredicate(input.publicTypes);

  const rows = await db
    .select({
      id: events.eventId,
      type: events.type,
      sourceTaskName: tasks.name,
      occurredAt: events.occurredAt,
      packetPublic: isPublic,
      packet: sql<unknown>`case when ${isPublic} then ${events.packet} else null end`,
    })
    .from(events)
    .leftJoin(tasks, eq(tasks.id, events.sourceTaskId))
    .where(
      and(
        eventOfWorkflow(input.workflowId),
        after ? sql`(${events.occurredAt}, ${events.eventId}) < (${after.at}, ${after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(events.occurredAt), desc(events.eventId))
    .limit(limit + 1);

  const page = pageOf(rows, limit, (r) => ({ at: r.occurredAt, id: r.id }));
  return {
    items: page.items.map(({ id, ...event }) => shapeEvent(event, id, input.ref)),
    nextCursor: page.nextCursor,
  };
}

export type PublicEventDetail = {
  event: PublicEvent;
  /** Oldest ancestor → this event. A private hop keeps its type and drops its packet. */
  lineage: PublicEvent[];
  triggered: Array<{ ref: string; taskName: string; status: RunStatus }>;
};

export async function publicEventGet(
  db: Db,
  input: PublicRead & { eventId: string },
): Promise<PublicEventDetail | undefined> {
  // Scope first: the ref already decodes only under this share, and this is the second lock.
  const [scoped] = await db
    .select({ id: events.eventId })
    .from(events)
    .where(and(eq(events.eventId, input.eventId), eventOfWorkflow(input.workflowId)));
  if (!scoped) return undefined;

  const walked = await chainIdsOf(db, input.eventId);
  const depth = new Map(walked.map((w) => [w.eventId, w.depth]));

  const rows = await selectPublicEvents(
    db,
    input.publicTypes,
    inArray(
      events.eventId,
      walked.map((w) => w.eventId),
    ),
  );

  // Deepest = furthest ancestor, so descending depth reads root → leaf.
  const lineage = rows
    .sort((a, b) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0))
    .map(({ id, ...event }) => shapeEvent(event, id, input.ref));
  const event = lineage.at(-1);
  if (!event) return undefined;

  const triggered = await db
    .select({ id: runs.id, taskName: tasks.name, status: runs.status })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.triggerEventId, input.eventId))
    .orderBy(runs.createdAt);

  return {
    event,
    lineage,
    triggered: triggered.map((t) => ({
      ref: input.ref.encode(t.id),
      taskName: t.taskName,
      status: t.status,
    })),
  };
}

type PublicEventColumns = {
  id: string;
  type: string;
  sourceTaskName: string | null;
  occurredAt: Date;
  packetPublic: boolean;
  packet: unknown;
};

/**
 * The one projection every public event path selects through — so "the packet column is
 * conditional" is written once and cannot be forgotten by the next caller that needs events.
 */
async function selectPublicEvents(
  db: Db,
  publicTypes: ReadonlySet<string>,
  where: SQL | undefined,
): Promise<PublicEventColumns[]> {
  const isPublic = publicTypePredicate(publicTypes);
  return db
    .select({
      id: events.eventId,
      type: events.type,
      sourceTaskName: tasks.name,
      occurredAt: events.occurredAt,
      packetPublic: isPublic,
      packet: sql<unknown>`case when ${isPublic} then ${events.packet} else null end`,
    })
    .from(events)
    .leftJoin(tasks, eq(tasks.id, events.sourceTaskId))
    .where(where);
}

/**
 * `type = any(...)` against the manifest. An empty manifest becomes a literal `false` rather
 * than an empty array, because `= any('{}')` is a comparison Postgres has to evaluate per
 * row and a constant it does not.
 */
function publicTypePredicate(publicTypes: ReadonlySet<string>): SQL<boolean> {
  const types = [...publicTypes];
  return types.length === 0
    ? sql<boolean>`false`
    : sql<boolean>`${events.type} = any(array[${sql.join(
        types.map((t) => sql`${t}`),
        sql`, `,
      )}]::text[])`;
}

function shapeEvent(
  event: { type: string; sourceTaskName: string | null; occurredAt: Date; packetPublic: boolean; packet: unknown },
  id: string,
  ref: RefCodec,
): PublicEvent {
  return {
    ref: ref.encode(id),
    type: event.type,
    sourceTaskName: event.sourceTaskName,
    occurredAt: event.occurredAt,
    packetPublic: event.packetPublic,
    ...(event.packetPublic ? { packet: event.packet } : {}),
  };
}

/** A hostile `limit` is clamped, not honoured (§16 Threat 16). */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE_LIMIT.default;
  return Math.min(Math.max(Math.trunc(limit), PAGE_LIMIT.min), PUBLIC_PAGE_MAX);
}

/** Lower than the owner's ceiling: this path serves unauthenticated callers. */
export const PUBLIC_PAGE_MAX = 50;

function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && (NODE_KINDS as readonly string[]).includes(value);
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && typeof value.x === "number" && typeof value.y === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
