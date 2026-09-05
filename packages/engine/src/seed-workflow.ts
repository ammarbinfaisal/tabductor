import { schedules, workflows, type Db, type ScheduleRow } from "@tabductor/db";
import { newId } from "@tabductor/core";
import { eq } from "drizzle-orm";
import { createWorkflow, publishVersion, type Graph, type GraphEvent, type NodeKind } from "./graph.js";
import { staticSchemaGenerator } from "./schema-generator.js";

/**
 * Builds a whole workflow — version, tasks, event entities, emit/consume declarations —
 * from one literal, because every engine test needs a graph and none of them should spend
 * twenty lines building one.
 *
 * Tasks are keyed by name, which is also their cross-version identity (see
 * `tasks.name`), so `edges` and the returned `taskIds` both read in those names:
 *
 * ```ts
 * const wf = await seedWorkflow(db, {
 *   tasks: { A: { stub: { emits: [{ type: "a.done" }] } }, B: {} },
 *   edges: [["A", "a.done", "B"]],
 * });
 * ```
 *
 * `edges` is *sugar* over the event-centric document: `[from, type, to]` compiles to
 * "`to` consumes `type`" — the emitter half is already carried by `from`'s declared or
 * scripted emits, and routing no longer cares who emitted. The spelling survives because
 * it is how a test reads aloud.
 *
 * It is an *adapter*, not a second way to write a graph: the rows all come out of
 * `publishVersion` (with a deterministic schema generator), so what the tests exercise is
 * the same path the control-plane API publishes through.
 */

export type SeedTask = {
  /** Defaults to `browser` — every task before S5a drove a page, and most tests still do. */
  kind?: NodeKind;
  mode?: string;
  prompt?: string;
  /** Scripted StubExecutor behavior; lands in `limits_json.stub`. */
  stub?: unknown;
  /** Per-task limits merged into `limits_json` verbatim — e.g. `{python: {wall_clock_ms}}`. */
  limits?: Record<string, unknown>;
  runTimeoutMs?: number;
  /** Retry policy; lands in `limits_json.retry`. */
  retry?: { max: number; backoff_ms?: number };
  /** Declared emitted events. A bare type gets a permissive schema. */
  emits?: Record<string, unknown> | string[];
  /** Event types that trigger this task — the direct spelling of what `edges` sugars. */
  consumes?: string[];
  /**
   * Which of the declared types a share viewer may read packets for (S2d). Everything not
   * listed stays private, which is also what a spec that omits this gets — the seed helper
   * has no reason to be the one place in the system where visibility defaults open.
   */
  publicEvents?: readonly string[];
};

/** `[fromTask, eventType, toTask]` — the whole edge, in the order you say it aloud. */
export type SeedEdge = readonly [from: string, eventType: string, to: string];

export type SeedSpec = {
  tasks: Record<string, SeedTask>;
  edges?: readonly SeedEdge[];
  /**
   * Explicit event entities, merged over the inferred ones. A test that cares about a
   * schema or a description says so here; everything else gets a permissive default.
   */
  events?: Record<string, { description?: string; public?: boolean; schema?: Record<string, unknown> }>;
  name?: string;
  userId?: string;
  maxHops?: number;
  /** Publish a new version of an existing workflow instead of creating one. */
  workflowId?: string;
};

export type SeededWorkflow = {
  workflowId: string;
  versionId: string;
  /** Task name → task id, for this version. */
  taskIds: Record<string, string>;
};

const ANY_OBJECT = { type: "object" };

export async function seedWorkflow(db: Db, spec: SeedSpec): Promise<SeededWorkflow> {
  const workflowId =
    spec.workflowId ??
    (await createWorkflow(db, {
      name: spec.name ?? "test workflow",
      userId: spec.userId ?? "user_test",
      ...(spec.maxHops === undefined ? {} : { maxHops: spec.maxHops }),
    }));
  if (spec.workflowId && spec.maxHops !== undefined) {
    await db.update(workflows).set({ maxHops: spec.maxHops }).where(eq(workflows.id, workflowId));
  }

  // Consumes: the direct field plus whatever the edges sugar wires in.
  const consumesOf = new Map<string, Set<string>>(
    Object.entries(spec.tasks).map(([name, task]) => [name, new Set(task.consumes ?? [])]),
  );
  for (const [, eventType, to] of spec.edges ?? []) {
    consumesOf.get(to)?.add(eventType);
  }

  // Event entities: every declared emit becomes one, explicit `events` entries win, and
  // each carries its schema into the deterministic generator below.
  const schemas: Record<string, Record<string, unknown>> = {};
  const entities = new Map<string, GraphEvent>();
  const declare = (type: string, patch: { description?: string; public?: boolean; schema?: Record<string, unknown> }) => {
    const existing = entities.get(type) ?? {
      type,
      description: `Test event "${type}".`,
      public: false,
    };
    entities.set(type, {
      ...existing,
      ...(patch.description === undefined ? {} : { description: patch.description }),
      public: existing.public || (patch.public ?? false),
    });
    if (patch.schema) schemas[type] = patch.schema;
  };

  for (const [, task] of Object.entries(spec.tasks)) {
    for (const [type, schema] of declaredEmits(task)) {
      declare(type, { schema, public: task.publicEvents?.includes(type) ?? false });
    }
  }
  for (const [type, event] of Object.entries(spec.events ?? {})) {
    declare(type, event);
  }

  const graph: Graph = {
    tasks: Object.entries(spec.tasks).map(([name, task]) => ({
      name,
      kind: task.kind ?? "browser",
      mode: task.mode ?? "stub",
      prompt: task.prompt ?? null,
      limits: {
        ...(task.stub === undefined ? {} : { stub: task.stub }),
        ...(task.runTimeoutMs === undefined ? {} : { run_timeout_ms: task.runTimeoutMs }),
        ...(task.retry === undefined ? {} : { retry: task.retry }),
        ...(task.limits ?? {}),
      },
      emits: declaredEmits(task).map(([type]) => type),
      consumes: [...(consumesOf.get(name) ?? [])],
      schedule: null,
      position: null,
    })),
    events: [...entities.values()],
  };

  const { versionId, taskIds } = await publishVersion(
    db,
    { workflowId, graph },
    { schemaGenerator: staticSchemaGenerator(schemas) },
  );
  return { workflowId, versionId, taskIds };
}

/** Attaches a cron schedule to a task. The row is the scheduler's whole input (§7). */
export async function seedSchedule(
  db: Db,
  spec: {
    taskId: string;
    cron: string;
    tz?: string;
    missedPolicy?: "skip" | "fire_once_catchup";
    overlapPolicy?: "skip" | "queue";
    lastFiredAt?: Date;
    enabled?: boolean;
  },
): Promise<ScheduleRow> {
  const [row] = await db
    .insert(schedules)
    .values({
      id: newId("sched"),
      taskId: spec.taskId,
      cron: spec.cron,
      ...(spec.tz === undefined ? {} : { tz: spec.tz }),
      ...(spec.missedPolicy === undefined ? {} : { missedPolicy: spec.missedPolicy }),
      ...(spec.overlapPolicy === undefined ? {} : { overlapPolicy: spec.overlapPolicy }),
      ...(spec.lastFiredAt === undefined ? {} : { lastFiredAt: spec.lastFiredAt }),
      ...(spec.enabled === undefined ? {} : { enabled: spec.enabled }),
    })
    .returning();
  return row!;
}

/**
 * Emitted-event declarations, defaulting to every type the stub script mentions — a test
 * that scripts an emit almost never wants to also spell out a schema for it.
 */
function declaredEmits(task: SeedTask): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(task.emits)) return task.emits.map((type) => [type, ANY_OBJECT]);
  if (task.emits) {
    return Object.entries(task.emits).map(([type, schema]) => [
      type,
      typeof schema === "object" && schema !== null && !Array.isArray(schema)
        ? (schema as Record<string, unknown>)
        : ANY_OBJECT,
    ]);
  }
  return stubEmitTypes(task.stub).map((type) => [type, ANY_OBJECT]);
}

function stubEmitTypes(stub: unknown): string[] {
  if (typeof stub !== "object" || stub === null) return [];
  const emits = Reflect.get(stub, "emits");
  if (!Array.isArray(emits)) return [];
  const types = new Set<string>();
  for (const emit of emits) {
    if (typeof emit === "object" && emit !== null) {
      const type = Reflect.get(emit, "type");
      if (typeof type === "string") types.add(type);
    }
  }
  return [...types];
}
