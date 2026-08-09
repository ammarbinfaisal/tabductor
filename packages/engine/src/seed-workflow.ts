import { newId } from "@tabductor/core";
import {
  edges,
  eventDefs,
  schedules,
  tasks,
  workflowVersions,
  workflows,
  type Db,
  type ScheduleRow,
} from "@tabductor/db";
import { eq } from "drizzle-orm";

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
  return db.transaction(async (trx) => {
    const workflowId = spec.workflowId ?? newId("wf");
    if (!spec.workflowId) {
      await trx.insert(workflows).values({
        id: workflowId,
        userId: spec.userId ?? "user_test",
        name: spec.name ?? "test workflow",
        ...(spec.maxHops === undefined ? {} : { maxHops: spec.maxHops }),
      });
    } else if (spec.maxHops !== undefined) {
      await trx.update(workflows).set({ maxHops: spec.maxHops }).where(eq(workflows.id, workflowId));
    }

    const versionId = newId("wfv");
    await trx.insert(workflowVersions).values({ id: versionId, workflowId });

    const taskIds: Record<string, string> = {};
    for (const [name, task] of Object.entries(spec.tasks)) {
      const id = newId("task");
      taskIds[name] = id;
      await trx.insert(tasks).values({
        id,
        workflowVersionId: versionId,
        name,
        prompt: task.prompt ?? null,
        mode: task.mode ?? "stub",
        limitsJson: {
          ...(task.stub === undefined ? {} : { stub: task.stub }),
          ...(task.runTimeoutMs === undefined ? {} : { run_timeout_ms: task.runTimeoutMs }),
          ...(task.retry === undefined ? {} : { retry: task.retry }),
        },
      });

      for (const [eventType, schema] of declaredEmits(task)) {
        await trx.insert(eventDefs).values({
          id: newId("evd"),
          taskId: id,
          eventType,
          packetSchemaJson: schema,
        });
      }
    }

    for (const [from, eventType, to] of spec.edges ?? []) {
      const fromTaskId = taskIds[from];
      const toTaskId = taskIds[to];
      if (!fromTaskId || !toTaskId) throw new Error(`edge ${from}->${to} names an unknown task`);
      await trx.insert(edges).values({
        id: newId("edge"),
        workflowVersionId: versionId,
        fromTaskId,
        eventType,
        toTaskId,
      });
    }

    // Point the workflow at the version just built; dispatch routes against it.
    await trx.update(workflows).set({ currentVersionId: versionId }).where(eq(workflows.id, workflowId));

    return { workflowId, versionId, taskIds };
  });
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
function declaredEmits(task: SeedTask): Array<[string, unknown]> {
  if (Array.isArray(task.emits)) return task.emits.map((type) => [type, ANY_OBJECT]);
  if (task.emits) return Object.entries(task.emits);
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
