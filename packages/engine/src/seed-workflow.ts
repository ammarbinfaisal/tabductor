import { schedules, workflows, type Db, type ScheduleRow } from "@tabductor/db";
import { newId } from "@tabductor/core";
import { eq } from "drizzle-orm";
import { createWorkflow, publishVersion, type Graph } from "./graph.js";

/**
 * Builds a whole workflow — version, tasks, edges, event_defs — from one literal, because
 * every engine test needs a graph and none of them should spend twenty lines building one.
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
 * It is an *adapter*, not a second way to write a graph: the rows all come out of
 * `publishVersion`, so what the tests exercise is the same path the control-plane API
 * publishes through.
 */

export type SeedTask = {
  mode?: string;
  prompt?: string;
  /** Scripted StubExecutor behavior; lands in `limits_json.stub`. */
  stub?: unknown;
  runTimeoutMs?: number;
  /** Retry policy; lands in `limits_json.retry`. */
  retry?: { max: number; backoff_ms?: number };
  /** Declared emitted events. A bare type gets a permissive schema. */
  emits?: Record<string, unknown> | string[];
};

/** `[fromTask, eventType, toTask]` — the whole edge, in the order you say it aloud. */
export type SeedEdge = readonly [from: string, eventType: string, to: string];

export type SeedSpec = {
  tasks: Record<string, SeedTask>;
  edges?: readonly SeedEdge[];
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

  const graph: Graph = {
    tasks: Object.entries(spec.tasks).map(([name, task]) => ({
      name,
      kind: "browser",
      mode: task.mode ?? "stub",
      prompt: task.prompt ?? null,
      limits: {
        ...(task.stub === undefined ? {} : { stub: task.stub }),
        ...(task.runTimeoutMs === undefined ? {} : { run_timeout_ms: task.runTimeoutMs }),
        ...(task.retry === undefined ? {} : { retry: task.retry }),
      },
      emits: declaredEmits(task).map(([type, packetSchema]) => ({ type, packetSchema })),
      schedule: null,
      position: null,
    })),
    edges: (spec.edges ?? []).map(([from, eventType, to]) => ({ from, eventType, to })),
  };

  const { versionId, taskIds } = await publishVersion(db, { workflowId, graph });
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
