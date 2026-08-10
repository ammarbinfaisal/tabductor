import { Ajv } from "ajv";
import { AppError, newId } from "@tabductor/core";
import {
  edges,
  eventDefs,
  schedules,
  tasks,
  workflowVersions,
  workflows,
  type Db,
} from "@tabductor/db";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

/**
 * The workflow graph: one document, authored by the editor, validated here, and exploded
 * into the `tasks`/`edges`/`event_defs`/`schedules` rows the engine routes against.
 *
 * Publishing is append-only (§5): every save writes a *new* `workflow_versions` row with
 * fresh task rows and repoints `workflows.current_version_id`. Nothing is updated in place,
 * so a run already executing keeps the graph it started under while new events route by the
 * new one — which is the versioning behaviour S2a's dispatch already assumes.
 */

/** A user-authored JSON Schema. Structurally an object here; ajv is what actually judges it. */
const packetSchemaSchema = z.record(z.unknown());

/**
 * Node kinds (§4). The column that will carry this (`tasks.kind`) arrives in S5a; until
 * then the graph document is its only home, which is enough for the two things that need
 * it today: the editor palette and the "a schedule may not bind to an asset node"
 * constraint below. S5a moves the constraint to a DB check and this stays its front door.
 */
export const NODE_KINDS = ["browser", "asset"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** `asset` nodes are event-triggered only (impl-phases S5a); `browser` may hold a schedule. */
const SCHEDULABLE: readonly NodeKind[] = ["browser"];

export const graphScheduleSchema = z.object({
  cron: z.string().min(1),
  tz: z.string().min(1).default("UTC"),
  missedPolicy: z.enum(["skip", "fire_once_catchup"]).default("skip"),
  overlapPolicy: z.enum(["skip", "queue"]).default("skip"),
  maxQueueDepth: z.number().int().positive().max(100).default(1),
  enabled: z.boolean().default(true),
});

export const graphTaskSchema = z.object({
  /** Identity across versions (`tasks.name`), so an edited graph still routes old events. */
  name: z.string().min(1).max(120),
  kind: z.enum(NODE_KINDS).default("browser"),
  mode: z.string().min(1).default("stub"),
  prompt: z.string().nullable().default(null),
  /** `limits_json`: run timeout, retry policy, and the StubExecutor script. */
  limits: z.record(z.unknown()).default({}),
  emits: z
    .array(
      z.object({
        type: z.string().min(1),
        packetSchema: packetSchemaSchema.default({ type: "object" }),
        /**
         * Share visibility (S2d, sharing.md §3.2). **This default is the control.** A node
         * added in a later version arrives private because of it, so no `checkGraph` rule
         * is needed and none should be added — a graph edit cannot silently widen a share
         * when there is no path by which `true` survives an author not writing it.
         */
        public: z.boolean().default(false),
      }),
    )
    .default([]),
  schedule: graphScheduleSchema.nullable().default(null),
  /** Editor-only decoration, round-tripped through `graph_json` and ignored by the engine. */
  position: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
});

export const graphEdgeSchema = z.object({
  from: z.string().min(1),
  eventType: z.string().min(1),
  to: z.string().min(1),
});

export const graphSchema = z.object({
  tasks: z.array(graphTaskSchema).max(200),
  edges: z.array(graphEdgeSchema).max(500).default([]),
});

export type Graph = z.infer<typeof graphSchema>;
export type GraphTask = z.infer<typeof graphTaskSchema>;

export const GRAPH_INVALID = "graph_invalid";

const invalid = (message: string, details: Record<string, unknown>): AppError =>
  new AppError(GRAPH_INVALID, message, { details });

/**
 * Everything that makes a graph unpublishable, checked before a single row is written and
 * reported with the node or edge at fault so the editor can mark it.
 *
 * Deliberately absent: "the edge's event type must be one the source node declares". Events
 * reach a task from outside the graph too — a manual trigger, and in S2b a schedule fire —
 * so requiring a declaration would outlaw the entry edge of every workflow.
 */
export function checkGraph(graph: Graph): void {
  // A throwaway instance: ajv keeps compiled schemas by `$id`, and a long-lived one would
  // reject the second publish of a schema that declares one as a duplicate registration.
  const ajv = new Ajv({ allErrors: true, strict: false });
  const seen = new Set<string>();
  for (const task of graph.tasks) {
    if (seen.has(task.name)) throw invalid(`duplicate task name "${task.name}"`, { task: task.name });
    seen.add(task.name);

    if (task.schedule && !SCHEDULABLE.includes(task.kind)) {
      throw invalid(`a schedule may not bind to a "${task.kind}" task`, {
        task: task.name,
        kind: task.kind,
      });
    }

    const types = new Set<string>();
    for (const emit of task.emits) {
      if (types.has(emit.type)) {
        throw invalid(`task "${task.name}" declares "${emit.type}" twice`, {
          task: task.name,
          eventType: emit.type,
        });
      }
      types.add(emit.type);

      // A packet schema that does not compile is a 400 now rather than a run failure later.
      try {
        ajv.compile(emit.packetSchema);
      } catch (err) {
        throw new AppError(
          GRAPH_INVALID,
          `task "${task.name}" declares an invalid packet schema for "${emit.type}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err, details: { task: task.name, eventType: emit.type } },
        );
      }
    }
  }

  for (const edge of graph.edges) {
    for (const end of [edge.from, edge.to]) {
      if (!seen.has(end)) {
        throw invalid(`edge ${edge.from} -[${edge.eventType}]-> ${edge.to} names unknown task "${end}"`, {
          edge: `${edge.from}|${edge.eventType}|${edge.to}`,
          task: end,
        });
      }
    }
  }
}

export type PublishedVersion = {
  versionId: string;
  /** Task name → the id of its row *in this version*. */
  taskIds: Record<string, string>;
};

export async function createWorkflow(
  db: Db,
  input: { name: string; userId: string; maxHops?: number },
): Promise<string> {
  const id = newId("wf");
  await db.insert(workflows).values({
    id,
    userId: input.userId,
    name: input.name,
    ...(input.maxHops === undefined ? {} : { maxHops: input.maxHops }),
  });
  return id;
}

/**
 * Validate, then write the whole version in one transaction — version row, task rows, their
 * declared events and schedules, the edges between them, and the pointer that makes it
 * current. Half a published graph would route events into a shape nobody authored.
 */
export async function publishVersion(
  db: Db,
  input: { workflowId: string; graph: Graph },
): Promise<PublishedVersion> {
  const graph = graphSchema.parse(input.graph);
  checkGraph(graph);

  return db.transaction(async (trx) => {
    const [workflow] = await trx.select().from(workflows).where(eq(workflows.id, input.workflowId));
    if (!workflow) {
      throw new AppError("workflow_not_found", `no workflow "${input.workflowId}"`, {
        details: { workflowId: input.workflowId },
      });
    }

    const versionId = newId("wfv");
    await trx.insert(workflowVersions).values({ id: versionId, workflowId: workflow.id, graphJson: graph });

    const taskIds: Record<string, string> = {};
    for (const task of graph.tasks) {
      const id = newId("task");
      taskIds[task.name] = id;
      await trx.insert(tasks).values({
        id,
        workflowVersionId: versionId,
        name: task.name,
        prompt: task.prompt,
        mode: task.mode,
        limitsJson: task.limits,
      });

      for (const emit of task.emits) {
        await trx.insert(eventDefs).values({
          id: newId("evd"),
          taskId: id,
          eventType: emit.type,
          packetSchemaJson: emit.packetSchema,
          public: emit.public,
        });
      }

      if (task.schedule) {
        await trx.insert(schedules).values({ id: newId("sched"), taskId: id, ...task.schedule });
      }
    }

    for (const edge of graph.edges) {
      await trx.insert(edges).values({
        id: newId("edge"),
        workflowVersionId: versionId,
        fromTaskId: taskIds[edge.from]!,
        eventType: edge.eventType,
        toTaskId: taskIds[edge.to]!,
      });
    }

    await trx.update(workflows).set({ currentVersionId: versionId }).where(eq(workflows.id, workflow.id));
    return { versionId, taskIds };
  });
}

/**
 * In-place edit of one node of the *current* version — prompt, mode, limits.
 *
 * Deliberately not a publish: these are the knobs you turn while watching a graph run
 * (retry counts, a stub script, a timeout), and forcing a new version for each would bury
 * the structural history the version list exists to show. Anything that changes the *shape*
 * of the graph goes through `publishVersion`.
 */
export async function updateTask(
  db: Db,
  input: { taskId: string; prompt?: string | null; mode?: string; limits?: Record<string, unknown> },
): Promise<void> {
  const patch = {
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.limits === undefined ? {} : { limitsJson: input.limits }),
  };
  if (Object.keys(patch).length === 0) return;

  const updated = await db.update(tasks).set(patch).where(eq(tasks.id, input.taskId)).returning({ id: tasks.id });
  if (updated.length === 0) {
    throw new AppError("task_not_found", `no task "${input.taskId}"`, { details: { taskId: input.taskId } });
  }
}

/**
 * The inverse: rows back into the document the editor edits.
 *
 * Rebuilt from the rows rather than served straight from `graph_json`, because the rows are
 * what the engine actually routes on and `task.update` writes to them. `graph_json` is
 * consulted for one thing only — node positions, which no row carries and losing which
 * would reshuffle the canvas on every reload.
 */
export async function readGraph(db: Db, versionId: string): Promise<Graph> {
  const [version] = await db.select().from(workflowVersions).where(eq(workflowVersions.id, versionId));
  if (!version) {
    throw new AppError("version_not_found", `no workflow version "${versionId}"`, {
      details: { versionId },
    });
  }

  const taskRows = await db.select().from(tasks).where(eq(tasks.workflowVersionId, versionId));
  const edgeRows = await db.select().from(edges).where(eq(edges.workflowVersionId, versionId));
  const nameOf = new Map(taskRows.map((t) => [t.id, t.name]));
  const stored = graphSchema.safeParse(version.graphJson);
  const decoration = new Map(
    (stored.success ? stored.data.tasks : []).map((t) => [t.name, { kind: t.kind, position: t.position }]),
  );

  const taskIds = taskRows.map((t) => t.id);
  const defRows = taskIds.length
    ? await db.select().from(eventDefs).where(inArray(eventDefs.taskId, taskIds))
    : [];
  const scheduleRows = taskIds.length
    ? await db.select().from(schedules).where(inArray(schedules.taskId, taskIds))
    : [];
  const scheduleOf = new Map(scheduleRows.map((s) => [s.taskId, s]));

  return {
    tasks: taskRows.map((row): GraphTask => {
      const schedule = scheduleOf.get(row.id);
      return {
        name: row.name,
        kind: decoration.get(row.name)?.kind ?? "browser",
        mode: row.mode,
        prompt: row.prompt,
        limits: asRecord(row.limitsJson),
        emits: defRows
          .filter((d) => d.taskId === row.id)
          .map((d) => ({
            type: d.eventType,
            packetSchema: asRecord(d.packetSchemaJson),
            public: d.public,
          })),
        schedule: schedule
          ? {
              cron: schedule.cron,
              tz: schedule.tz,
              missedPolicy: schedule.missedPolicy === "fire_once_catchup" ? "fire_once_catchup" : "skip",
              overlapPolicy: schedule.overlapPolicy === "queue" ? "queue" : "skip",
              maxQueueDepth: schedule.maxQueueDepth,
              enabled: schedule.enabled,
            }
          : null,
        position: decoration.get(row.name)?.position ?? null,
      };
    }),
    edges: edgeRows.flatMap((e) => {
      const from = e.fromTaskId && nameOf.get(e.fromTaskId);
      const to = nameOf.get(e.toTaskId);
      return from && to ? [{ from, eventType: e.eventType, to }] : [];
    }),
  };
}

/** jsonb columns are `unknown` by construction; anything not an object reads as empty. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
