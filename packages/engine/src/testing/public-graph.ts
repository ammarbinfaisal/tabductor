import { eventDefs, taskConsumes, taskEmits, tasks, schedules, workflowVersions, type Db, type TaskKind as NodeKind, type MissedPolicy, type OverlapPolicy } from "@tabductor/db";
import { asc, eq, inArray, sql } from "drizzle-orm";
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isPosition = (v: unknown): v is {x:number;y:number} => isRecord(v) && typeof v.x === "number" && typeof v.y === "number";
export type PublicGraphEvent = {
  type: string;
  public: boolean;
  /** Present only for a public type — the fields are part of the manifest. */
  packetSchema?: Record<string, unknown>;
};

export type PublicGraphTask = {
  name: string;
  kind: NodeKind;
  /** Open by design (`stub`, then `ai`/`compiled`/`python`) — not a closed domain to narrow. */
  mode: string;
  position: { x: number; y: number } | null;
  /** Types only — the events entity list below carries visibility and schemas. */
  emits: string[];
  consumes: string[];
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
  /** The event entities — the manifest a share panel actually renders. */
  events: PublicGraphEvent[];
  /** Derived, not stored: emitters of a type × its consumers. Kept for graph rendering. */
  edges: Array<{ from: string; eventType: string; to: string }>;
};

/**
 * The graph as a viewer sees it: shape, kinds, modes, schedules and which events are
 * shared. Not `readGraph` with fields removed — that would select prompts and limits.
 *
 * `kind` reads straight from `tasks.kind` (S5a). `position` still has no column, so it
 * comes from `graph_json` — projected **in Postgres** down to the one key this needs
 * rather than parsed here and picked over (that document also holds prompts and stub
 * scripts, neither of which belongs in a public read model).
 */
export async function publicGraph(db: Db, input: { versionId: string }): Promise<PublicGraph> {
  const decorationRows = await db.execute<{ decoration: Record<string, { position?: unknown }> }>(sql`
    select coalesce(
      (
        select jsonb_object_agg(t->>'name', jsonb_build_object('position', t->'position'))
        from jsonb_array_elements(${workflowVersions.definitionJson} -> 'tasks') t
        where jsonb_typeof(t->'name') = 'string'
      ),
      '{}'::jsonb
    ) as decoration
    from ${workflowVersions}
    where ${workflowVersions.id} = ${input.versionId}
  `);
  const decoration = decorationRows.rows[0]?.decoration ?? {};

  const taskRows = await db
    .select({ id: tasks.id, name: tasks.name, kind: tasks.kind, mode: tasks.mode })
    .from(tasks)
    .where(eq(tasks.workflowVersionId, input.versionId))
    .orderBy(asc(tasks.name));
  const taskIds = taskRows.map((t) => t.id);

  // The packet schema is selected only where the type is public — same rule as packets.
  // A drizzle select rather than `db.execute`: the conditional projection is the only part
  // that needs raw SQL, and hand-writing the rest would mean hand-asserting its row type.
  const eventRows = await db
    .select({
      eventType: eventDefs.eventType,
      public: eventDefs.public,
      packetSchema: sql<unknown>`case when ${eventDefs.public} then ${eventDefs.packetSchemaJson} else null end`,
    })
    .from(eventDefs)
    .where(eq(eventDefs.workflowVersionId, input.versionId))
    .orderBy(asc(eventDefs.eventType));

  const emitRows = await db
    .select({ taskId: taskEmits.taskId, eventType: taskEmits.eventType })
    .from(taskEmits)
    .where(eq(taskEmits.workflowVersionId, input.versionId));
  const consumeRows = await db
    .select({ taskId: taskConsumes.taskId, eventType: taskConsumes.eventType })
    .from(taskConsumes)
    .where(eq(taskConsumes.workflowVersionId, input.versionId));

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

  const nameOf = new Map(taskRows.map((t) => [t.id, t.name]));

  // Topology is derived: every emitter of a type feeds every consumer of it.
  const consumersOf = new Map<string, string[]>();
  for (const c of consumeRows) {
    const to = nameOf.get(c.taskId);
    if (!to) continue;
    const list = consumersOf.get(c.eventType);
    if (list) list.push(to);
    else consumersOf.set(c.eventType, [to]);
  }
  const derivedEdges = emitRows.flatMap((e) => {
    const from = nameOf.get(e.taskId);
    if (!from) return [];
    return (consumersOf.get(e.eventType) ?? []).map((to) => ({ from, eventType: e.eventType, to }));
  });

  return {
    tasks: taskRows.map((row) => {
      const schedule = scheduleOf.get(row.id);
      const decorated = decoration[row.name];
      return {
        name: row.name,
        kind: row.kind,
        mode: row.mode,
        position: isPosition(decorated?.position) ? decorated.position : null,
        emits: emitRows
          .filter((e) => e.taskId === row.id)
          .map((e) => e.eventType)
          .sort(),
        consumes: consumeRows
          .filter((c) => c.taskId === row.id)
          .map((c) => c.eventType)
          .sort(),
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
    events: eventRows.map((e) => ({
      type: e.eventType,
      public: e.public,
      ...(e.public && isRecord(e.packetSchema) ? { packetSchema: e.packetSchema } : {}),
    })),
    edges: derivedEdges,
  };
}

