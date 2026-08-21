import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
const addFormats = addFormatsModule.default ?? addFormatsModule;
import { AppError, ASSET_REF_SCHEMA, newId, PYTHON_RUNTIME_MANIFEST } from "@tabductor/core";
import {
  eventDefs,
  schedules,
  taskConsumes,
  taskEmits,
  tasks,
  workflowVersions,
  workflows,
  MISSED_POLICIES,
  OVERLAP_POLICIES,
  TASK_KINDS,
  type Db,
  type TaskKind,
} from "@tabductor/db";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { promptHashOf, type SchemaGenerator, type SchemaGenInput } from "./schema-generator.js";

/**
 * The workflow graph: one document, authored by the editor, validated here, and exploded
 * into the `tasks`/`event_defs`/`task_emits`/`task_consumes`/`schedules` rows the engine
 * routes against.
 *
 * The document is event-centric: events are first-class entries describing a packet in
 * plain language, tasks declare which types they consume (their triggers) and emit, and
 * topology is *derived* by matching types — there are no authored edges. Nothing in the
 * document is JSON Schema; packet schemas are compiled from the descriptions at publish
 * time by the injected SchemaGenerator and gated deterministically with ajv.
 *
 * Publishing is append-only (§5): every save writes a *new* `workflow_versions` row with
 * fresh task rows and repoints `workflows.current_version_id`. Nothing is updated in place,
 * so a run already executing keeps the graph it started under while new events route by the
 * new one — which is the versioning behaviour S2a's dispatch already assumes.
 */

/** An event as the author declares it: a name, what the packet means, who may see it. */
export const graphEventSchema = z.object({
  type: z.string().min(1).max(200),
  /** The prompt the schema compiler works from — required, because it *is* the schema. */
  description: z.string().min(1).max(4000),
  /**
   * Share visibility (S2d, sharing.md §3.2). **This default is the control.** An event
   * added in a later version arrives private because of it, so no `checkGraph` rule
   * is needed and none should be added — a graph edit cannot silently widen a share
   * when there is no path by which `true` survives an author not writing it.
   */
  public: z.boolean().default(false),
});

/**
 * Node kinds (§4). Re-exported rather than restated: `tasks.kind` (S5a) is the column this
 * document projects to at publish, so the document's zod enum and the DB check constraint
 * must read from the same list or the two could drift.
 */
export const NODE_KINDS = TASK_KINDS;
export type NodeKind = TaskKind;

/** `asset` nodes are event-triggered only (§4); `browser` and `decision` (S5g,
 * graph-compilation-llm §2.1) may hold a schedule — a decision node is the planner that a
 * cron tick drives with an empty packet (§2.2). */
const SCHEDULABLE: readonly NodeKind[] = ["browser", "decision"];

/** `asset` tasks are never compiled (§11: MCP results and LLM prose have no stable structure
 * for the script compiler's guards to assert on). Re-asserted by the named DB check
 * `tasks_kind_mode_check` for a write that bypasses this save-time reject. */
const NOT_COMPILABLE: readonly NodeKind[] = ["asset"];

export const graphScheduleSchema = z.object({
  cron: z.string().min(1),
  tz: z.string().min(1).default("UTC"),
  // Built from the column domains rather than restating them: the document and the row it
  // becomes cannot disagree about what a policy is.
  missedPolicy: z.enum(MISSED_POLICIES).default("skip"),
  overlapPolicy: z.enum(OVERLAP_POLICIES).default("skip"),
  maxQueueDepth: z.number().int().positive().max(100).default(1),
  enabled: z.boolean().default(true),
});

/**
 * S5h — the Python task's program (`python-compute.md` §3.5). `language` is a literal
 * rather than an open string because it is the whole enum today: guest-side Python is the
 * only compute mode this document specifies, and widening it is a schema change, not a
 * new string value slipping through.
 */
export const graphCodeSchema = z.object({
  language: z.literal("python"),
  source: z.string().min(1).max(200_000),
});

/**
 * S5h — declared inputs and the pinned image (`python-compute.md` §3.1, §4). `tables` is
 * declared but not wired: it names tables, and resolving one needs a SELECT this document has
 * no place for. `checkGraph` rejects a non-empty value rather than accept a declaration
 * nothing can honour.
 */
export const graphRuntimeSchema = z.object({
  image: z.string().min(1),
  packages: z.array(z.string().min(1)).default([]),
  inputs: z
    .object({
      assets: z.array(z.string().min(1)).default([]),
      tables: z.array(z.string().min(1)).default([]),
    })
    .default({}),
});

export const graphTaskSchema = z.object({
  /** Identity across versions (`tasks.name`), so an edited graph still routes old events. */
  name: z.string().min(1).max(120),
  kind: z.enum(NODE_KINDS).default("browser"),
  mode: z.string().min(1).default("stub"),
  prompt: z.string().nullable().default(null),
  /** `limits_json`: run timeout, retry policy, and the StubExecutor script. */
  limits: z.record(z.unknown()).default({}),
  /** Event types this task may emit. The types' schemas live on the events, not here. */
  emits: z.array(z.string().min(1)).default([]),
  /** Event types that trigger this task — its subscriptions. Wiring is these lists. */
  consumes: z.array(z.string().min(1)).default([]),
  schedule: graphScheduleSchema.nullable().default(null),
  /** S5h: the `mode=python` program. `null` for every other mode. */
  code: graphCodeSchema.nullable().default(null),
  /** S5h: the `mode=python` image/package/input declaration. `null` for every other mode. */
  runtime: graphRuntimeSchema.nullable().default(null),
  /** Editor-only decoration, round-tripped through `graph_json` and ignored by the engine. */
  position: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
});

export const graphSchema = z.object({
  tasks: z.array(graphTaskSchema).max(200),
  events: z.array(graphEventSchema).max(500).default([]),
});

export type Graph = z.infer<typeof graphSchema>;
export type GraphTask = z.infer<typeof graphTaskSchema>;
export type GraphEvent = z.infer<typeof graphEventSchema>;
export type GraphCode = z.infer<typeof graphCodeSchema>;
export type GraphRuntime = z.infer<typeof graphRuntimeSchema>;

export const GRAPH_INVALID = "graph_invalid";
export const GRAPH_COMPILE_FAILED = "graph_compile_failed";

/** One line of the publish-time compile report: what happened to each event's schema. */
export type CompileEntry = {
  type: string;
  status: "generated" | "reused" | "failed";
  error?: string;
};
export type CompileReport = { events: CompileEntry[] };

const invalid = (message: string, details: Record<string, unknown>): AppError =>
  new AppError(GRAPH_INVALID, message, { details });

/**
 * Everything that makes a graph unpublishable, checked before a single row is written and
 * reported with the node or event at fault so the editor can mark it.
 *
 * Emits must reference declared events — an emit whose type has no entry would sail past
 * publish and then fail every run at `validatePacket`. Consumes are deliberately allowed
 * to reference undeclared types: system events (`run.failed`), manual triggers, and
 * events injected from outside the graph are all legitimate subscriptions with no
 * in-graph emitter, and demanding a declaration would force authors to describe packets
 * this graph never produces. (The old edge model made the same call for entry edges.)
 */
export function checkGraph(graph: Graph): void {
  const seen = new Set<string>();
  const declared = new Set(graph.events.map((e) => e.type));

  const types = new Set<string>();
  for (const event of graph.events) {
    if (types.has(event.type)) {
      throw invalid(`event "${event.type}" is declared twice`, { eventType: event.type });
    }
    types.add(event.type);
  }

  for (const task of graph.tasks) {
    if (seen.has(task.name)) throw invalid(`duplicate task name "${task.name}"`, { task: task.name });
    seen.add(task.name);

    if (task.schedule && !SCHEDULABLE.includes(task.kind)) {
      throw invalid(`a schedule may not bind to a "${task.kind}" task`, {
        task: task.name,
        kind: task.kind,
      });
    }

    if (task.mode === "compiled" && NOT_COMPILABLE.includes(task.kind)) {
      throw invalid(`a "${task.kind}" task may not use mode "compiled"`, {
        task: task.name,
        kind: task.kind,
        mode: task.mode,
      });
    }

    // S5h: `mode=python` requires `kind=asset` (§2.2) — re-asserted here (the save-time
    // reject, §5) even though `tasks_kind_mode_check` is the backstop for a write that
    // bypasses this, per the same division of labour `NOT_COMPILABLE` follows above.
    if (task.mode === "python" && task.kind !== "asset") {
      throw invalid(`a "${task.kind}" task may not use mode "python"`, {
        task: task.name,
        kind: task.kind,
        mode: task.mode,
      });
    }

    // `tables` (python-compute.md §3.1) is declared but not wired. Not for want of a store —
    // S5g shipped one — but because the field holds table *names*, and §3.1 wants "the declared
    // SELECT [run] host-side under the workflow's reader role". There is nowhere in this
    // document for that SELECT to live, so honouring `tables` needs a schema change giving each
    // entry a query, the fenced-SQL gate pointed at that new authoring surface, and a
    // materializer. Rejecting is better than accepting a declaration nothing can honour.
    if (task.runtime && task.runtime.inputs.tables.length > 0) {
      throw invalid(
        `task "${task.name}" declares runtime.inputs.tables, which is not wired yet — it needs a ` +
          `per-table declared SELECT in the graph document and a host-side materializer`,
        { task: task.name },
      );
    }

    if (task.mode === "python") {
      if (!task.code) {
        throw invalid(`task "${task.name}" has mode "python" but no code`, { task: task.name });
      }
      if (!task.runtime) {
        throw invalid(`task "${task.name}" has mode "python" but no runtime declaration`, { task: task.name });
      }
      const manifest = PYTHON_RUNTIME_MANIFEST[task.runtime.image];
      if (!manifest) {
        throw invalid(`task "${task.name}" declares unknown runtime image "${task.runtime.image}"`, {
          task: task.name,
          image: task.runtime.image,
        });
      }
      const unlisted = task.runtime.packages.filter((p) => !manifest.includes(p));
      if (unlisted.length > 0) {
        throw invalid(
          `task "${task.name}" declares package(s) not in the "${task.runtime.image}" manifest: ${unlisted.join(", ")}`,
          { task: task.name, image: task.runtime.image, packages: unlisted },
        );
      }
    } else if (task.code) {
      throw invalid(`task "${task.name}" declares code but has mode "${task.mode}", not "python"`, {
        task: task.name,
        mode: task.mode,
      });
    }

    for (const [label, list] of [
      ["emits", task.emits],
      ["consumes", task.consumes],
    ] as const) {
      const dupe = list.find((t, i) => list.indexOf(t) !== i);
      if (dupe !== undefined) {
        throw invalid(`task "${task.name}" declares "${dupe}" twice in ${label}`, {
          task: task.name,
          eventType: dupe,
        });
      }
    }

    for (const type of task.emits) {
      if (!declared.has(type)) {
        throw invalid(
          `task "${task.name}" emits "${type}" but no event with that type is declared`,
          { task: task.name, eventType: type },
        );
      }
    }
  }
}

export type PublishedVersion = {
  versionId: string;
  /** Task name → the id of its row *in this version*. */
  taskIds: Record<string, string>;
  report: CompileReport;
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

/** The generator context for one event: its description plus everyone touching it. */
function genInputFor(graph: Graph, event: GraphEvent): SchemaGenInput {
  const touching = (list: "emits" | "consumes") =>
    graph.tasks
      .filter((t) => t[list].includes(event.type))
      .map((t) => ({ name: t.name, prompt: t.prompt }));
  return {
    eventType: event.type,
    description: event.description,
    emitters: touching("emits"),
    consumers: touching("consumes"),
  };
}

/** How many events compile concurrently on a publish; the rest queue behind them. */
const COMPILE_CONCURRENCY = 4;

type CompiledEvent = {
  event: GraphEvent;
  promptHash: string;
  schema: Record<string, unknown>;
  entry: CompileEntry;
};

/**
 * The publish-time schema compiler (graph-compilation-llm.md §4 P3, minimal v1).
 *
 * Per event: hash its generator context; a match against the previous version's stored
 * hash carries that schema forward untouched (zero generator calls — the steady state of
 * a publish that edits stubs or timeouts). Changed and new events go to the generator,
 * whose output is only accepted if it compiles under ajv *strict* — the deterministic
 * gate that makes LLM authorship safe. Failures don't stop the pass: every event gets a
 * report entry, because the author fixing a graph wants all the bad news at once.
 */
async function compileEventSchemas(
  graph: Graph,
  previous: Map<string, { promptHash: string; schema: Record<string, unknown> }>,
  generator: SchemaGenerator,
): Promise<CompiledEvent[]> {
  // Formats are part of the generator's allowlist (`uri`, `date-time`, …), so the gate
  // must know them — an unknown format is a strict-mode failure, which is correct for
  // formats *outside* the allowlist.
  const ajv = addFormats(new Ajv({ allErrors: true, strict: true }));
  // S5d §18.2: same registration as `packet-schema.ts`'s runtime instance, on the
  // publish-time strict gate — a stored schema that `$ref`s "assetRef" must compile here
  // too, or a hand-authored one would pass the runtime validator and fail publish.
  ajv.addSchema(ASSET_REF_SCHEMA, "assetRef");

  const compiled: CompiledEvent[] = graph.events.map((event) => ({
    event,
    promptHash: promptHashOf(genInputFor(graph, event)),
    schema: {},
    entry: { type: event.type, status: "failed" },
  }));

  const pending: CompiledEvent[] = [];
  for (const item of compiled) {
    const prev = previous.get(item.event.type);
    if (prev && prev.promptHash !== "" && prev.promptHash === item.promptHash) {
      item.schema = prev.schema;
      item.entry = { type: item.event.type, status: "reused" };
    } else {
      pending.push(item);
    }
  }

  const queue = [...pending];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const result = await generator.generate(genInputFor(graph, item.event));
      if (!result.ok) {
        item.entry = { type: item.event.type, status: "failed", error: result.error };
        continue;
      }
      try {
        ajv.compile(result.schema);
      } catch (err) {
        item.entry = {
          type: item.event.type,
          status: "failed",
          error: `generated schema does not compile: ${err instanceof Error ? err.message : String(err)}`,
        };
        continue;
      }
      item.schema = result.schema;
      item.entry = { type: item.event.type, status: "generated" };
    }
  };
  await Promise.all(Array.from({ length: COMPILE_CONCURRENCY }, worker));

  return compiled;
}

/**
 * Validate, compile, then write the whole version in one transaction — version row, task
 * rows, their emit/consume declarations, the event entities with their compiled schemas,
 * schedules, and the pointer that makes it current. Half a published graph would route
 * events into a shape nobody authored.
 *
 * Generation happens *before* the transaction: it is the slow, fallible part, and a
 * failed compile must leave the workflow exactly as it was — current version unmoved, no
 * rows written. The whole report rides out on the error so the editor can mark every
 * failed event, not just the first.
 */
export async function publishVersion(
  db: Db,
  input: { workflowId: string; graph: Graph },
  deps: { schemaGenerator: SchemaGenerator },
): Promise<PublishedVersion> {
  const graph = graphSchema.parse(input.graph);
  checkGraph(graph);

  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, input.workflowId));
  if (!workflow) {
    throw new AppError("workflow_not_found", `no workflow "${input.workflowId}"`, {
      details: { workflowId: input.workflowId },
    });
  }

  const previous = new Map<string, { promptHash: string; schema: Record<string, unknown> }>();
  if (workflow.currentVersionId) {
    const rows = await db
      .select()
      .from(eventDefs)
      .where(eq(eventDefs.workflowVersionId, workflow.currentVersionId));
    for (const row of rows) {
      previous.set(row.eventType, {
        promptHash: row.promptHash,
        schema: asRecord(row.packetSchemaJson),
      });
    }
  }

  const compiled = await compileEventSchemas(graph, previous, deps.schemaGenerator);
  const report: CompileReport = { events: compiled.map((c) => c.entry) };
  const failed = report.events.filter((e) => e.status === "failed");
  if (failed.length > 0) {
    throw new AppError(
      GRAPH_COMPILE_FAILED,
      `${failed.length} event schema(s) failed to compile`,
      { details: { report } },
    );
  }

  return db.transaction(async (trx) => {
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
        kind: task.kind,
        mode: task.mode,
        limitsJson: task.limits,
        // S5h: projected here, at publish, and nowhere else — `updateTask` deliberately
        // never touches these three columns (see its own doc comment: code is structural
        // history, not a knob you turn while watching a run).
        codeSource: task.code?.source ?? null,
        codeSha256: task.code ? createHash("sha256").update(task.code.source, "utf8").digest("hex") : null,
        runtimeJson: task.runtime ?? null,
      });

      for (const type of task.emits) {
        await trx.insert(taskEmits).values({ taskId: id, workflowVersionId: versionId, eventType: type });
      }
      for (const type of task.consumes) {
        await trx.insert(taskConsumes).values({ taskId: id, workflowVersionId: versionId, eventType: type });
      }

      if (task.schedule) {
        await trx.insert(schedules).values({ id: newId("sched"), taskId: id, ...task.schedule });
      }
    }

    for (const item of compiled) {
      await trx.insert(eventDefs).values({
        id: newId("evd"),
        workflowVersionId: versionId,
        eventType: item.event.type,
        description: item.event.description,
        packetSchemaJson: item.schema,
        promptHash: item.promptHash,
        public: item.event.public,
      });
    }

    await trx.update(workflows).set({ currentVersionId: versionId }).where(eq(workflows.id, workflow.id));
    return { versionId, taskIds, report };
  });
}

/**
 * In-place edit of one node of the *current* version — prompt, mode, limits.
 *
 * Deliberately not a publish: these are the knobs you turn while watching a graph run
 * (retry counts, a stub script, a timeout), and forcing a new version for each would bury
 * the structural history the version list exists to show. Anything that changes the *shape*
 * of the graph goes through `publishVersion`.
 *
 * Note the schema-compiler consequence: a task's `prompt` is generator *context*, so
 * editing it here changes what the next publish will hash — the connected events
 * recompile then, not now. Schemas only ever change at publish.
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
 * Rebuilt from the rows rather than served straight from `graph_json`, because the rows
 * are what the engine actually routes on and `task.update` writes to them. `graph_json`
 * is consulted for one thing only now — node positions, which no row carries and losing
 * which would reshuffle the canvas on every reload. (Versions published under the old
 * edge-shaped document fail that parse and degrade to a null position; their routing rows,
 * including `kind`, read from `tasks` regardless.)
 *
 * Event descriptions and visibility come back; the compiled schemas deliberately do not —
 * they are not part of the authored document. `readEventSchemas` serves them read-only.
 *
 * `kind` (S5a) reads from the `tasks.kind` column, not from `graph_json` — the projection
 * `publishVersion` writes is the source of truth for what routing and dispatch actually see.
 * `position` still comes from the document; no row carries it.
 */
export async function readGraph(db: Db, versionId: string): Promise<Graph> {
  const [version] = await db.select().from(workflowVersions).where(eq(workflowVersions.id, versionId));
  if (!version) {
    throw new AppError("version_not_found", `no workflow version "${versionId}"`, {
      details: { versionId },
    });
  }

  const taskRows = await db.select().from(tasks).where(eq(tasks.workflowVersionId, versionId));
  const stored = graphSchema.safeParse(version.graphJson);
  const decoration = new Map(
    (stored.success ? stored.data.tasks : []).map((t) => [t.name, { position: t.position }]),
  );

  const emitRows = await db.select().from(taskEmits).where(eq(taskEmits.workflowVersionId, versionId));
  const consumeRows = await db
    .select()
    .from(taskConsumes)
    .where(eq(taskConsumes.workflowVersionId, versionId));
  const eventRows = await db.select().from(eventDefs).where(eq(eventDefs.workflowVersionId, versionId));

  const taskIds = taskRows.map((t) => t.id);
  const scheduleRows = taskIds.length
    ? await db.select().from(schedules).where(inArray(schedules.taskId, taskIds))
    : [];
  const scheduleOf = new Map(scheduleRows.map((s) => [s.taskId, s]));

  return {
    tasks: taskRows.map((row): GraphTask => {
      const schedule = scheduleOf.get(row.id);
      return {
        name: row.name,
        kind: row.kind,
        mode: row.mode,
        prompt: row.prompt,
        limits: asRecord(row.limitsJson),
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
              maxQueueDepth: schedule.maxQueueDepth,
              enabled: schedule.enabled,
            }
          : null,
        // S5h: read from the `tasks` columns `publishVersion` projected to, the same rule
        // `kind` already follows — never from `graph_json`.
        code: row.codeSource ? { language: "python", source: row.codeSource } : null,
        runtime: graphRuntimeSchema.nullable().catch(null).parse(row.runtimeJson),
        position: decoration.get(row.name)?.position ?? null,
      };
    }),
    events: eventRows
      .map((e): GraphEvent => ({ type: e.eventType, description: e.description, public: e.public }))
      .sort((a, b) => a.type.localeCompare(b.type)),
  };
}

/**
 * The compiled schemas for a version, keyed by type — read-only companion to `readGraph`
 * for the editor's schema display. Never part of the document; the client cannot send
 * one back.
 */
export async function readEventSchemas(
  db: Db,
  versionId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const rows = await db.select().from(eventDefs).where(eq(eventDefs.workflowVersionId, versionId));
  return Object.fromEntries(rows.map((r) => [r.eventType, asRecord(r.packetSchemaJson)]));
}

/** jsonb columns are `unknown` by construction; anything not an object reads as empty. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
