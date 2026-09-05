import { afterEach, expect, it } from "vitest";
import { AppError, newId } from "@tabductor/core";
import { events, schedules, tasks, workflows } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  AssetExecutor,
  createWorkflow,
  executorKey,
  GRAPH_INVALID,
  publishVersion,
  seedWorkflow,
  staticSchemaGenerator,
  StubExecutor,
  triggerTask,
  updateTask,
  type Graph,
} from "@tabductor/engine";
import { eq } from "drizzle-orm";
import { runsForTask, startRig, waitFor, waitForQuiet, type Rig } from "./engine-support.js";

/** drizzle-orm wraps the driver error (`Failed query: ...`) and puts Postgres's own message
 * — the one this file's assertions care about — on `.cause`; `toThrow` only ever looks at
 * `.message`, so every direct-write rejection in this file is checked here instead. */
async function causeMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    return cause instanceof Error ? cause.message : String(err);
  }
  throw new Error("expected the promise to reject");
}

/**
 * S5a: `tasks.kind` as a real column and executor-registry key. Two things are asserted
 * twice each, deliberately — once at the control-plane boundary (`publishVersion`, a typed
 * `AppError`) and once at the database (a direct write that skips `publishVersion`
 * entirely) — because the spec (§5) makes the DB constraints the backstop for exactly that
 * bypass, not a restatement of the same check for its own sake.
 */

const noGenerator = staticSchemaGenerator({});

async function freshWorkflow(handle: MigratedTestDb): Promise<string> {
  return createWorkflow(handle.db, { name: "kind-constraints", userId: "user_test" });
}

const emptyGraph = (task: Partial<Graph["tasks"][number]> & { kind: "browser" | "asset" }): Graph => ({
  tasks: [
    {
      name: "T",
      mode: "ai",
      prompt: null,
      limits: {},
      emits: [],
      consumes: [],
      schedule: null,
      position: null,
      ...task,
    },
  ],
  events: [],
});

let handle: MigratedTestDb | undefined;
let rig: Rig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
  await handle?.close();
  handle = undefined;
});

it("publishVersion rejects a schedule bound to a kind=asset task, and persists nothing", async () => {
  handle = await createMigratedTestDb();
  const workflowId = await freshWorkflow(handle);
  const graph = emptyGraph({
    kind: "asset",
    schedule: { cron: "* * * * *", tz: "UTC", missedPolicy: "skip", overlapPolicy: "skip", maxQueueDepth: 1, enabled: true },
  });

  const err = await publishVersion(handle.db, { workflowId, graph }, { schemaGenerator: noGenerator }).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(GRAPH_INVALID);

  const [workflow] = await handle.db.select().from(workflows).where(eq(workflows.id, workflowId));
  expect(workflow?.currentVersionId).toBeNull();
});

it("publishVersion rejects kind=asset with mode=compiled", async () => {
  handle = await createMigratedTestDb();
  const workflowId = await freshWorkflow(handle);
  const graph = emptyGraph({ kind: "asset", mode: "compiled" });

  const err = await publishVersion(handle.db, { workflowId, graph }, { schemaGenerator: noGenerator }).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(GRAPH_INVALID);

  const [workflow] = await handle.db.select().from(workflows).where(eq(workflows.id, workflowId));
  expect(workflow?.currentVersionId).toBeNull();
});

it("a direct schedule insert on an asset task is rejected by the constraint trigger", async () => {
  handle = await createMigratedTestDb();
  const workflowId = await freshWorkflow(handle);
  const graph = emptyGraph({ kind: "asset", mode: "ai" });
  const { taskIds } = await publishVersion(handle.db, { workflowId, graph }, { schemaGenerator: noGenerator });

  const message = await causeMessage(
    handle.db.insert(schedules).values({ id: newId("sched"), taskId: taskIds.T!, cron: "* * * * *" }),
  );
  expect(message).toContain("schedules may not bind to a kind=asset task");
});

it("a direct update flipping an asset task to mode=compiled is rejected by the check constraint", async () => {
  handle = await createMigratedTestDb();
  const workflowId = await freshWorkflow(handle);
  const graph = emptyGraph({ kind: "asset", mode: "ai" });
  const { taskIds } = await publishVersion(handle.db, { workflowId, graph }, { schemaGenerator: noGenerator });

  const message = await causeMessage(
    handle.db.update(tasks).set({ mode: "compiled" }).where(eq(tasks.id, taskIds.T!)),
  );
  expect(message).toContain("tasks_kind_mode_check");
});

it("an event emitted by a browser task triggers an asset task, which runs under AssetExecutor", async () => {
  rig = await startRig({
    executors: {
      [executorKey("browser", "stub")]: StubExecutor,
      [executorKey("asset", "ai")]: AssetExecutor,
    },
  });
  const db = rig.handle.db;

  const wf = await seedWorkflow(db, {
    tasks: {
      Watcher: { stub: { emits: [{ type: "a.done", packet: { hello: "world" } }] } },
      Processor: { kind: "asset", mode: "ai", consumes: ["a.done"] },
    },
  });

  await triggerTask(db, { taskId: wf.taskIds.Watcher! });
  await waitForQuiet(rig);

  // Only `(asset, ai)` is registered to `AssetExecutor` in this rig — a run reaching
  // `succeeded` here is only possible if dispatch resolved that exact key, not `StubExecutor`
  // under a different one (there is no `(asset, stub)` registration to fall back to).
  const processorRuns = await runsForTask(rig, wf.taskIds.Processor!);
  expect(processorRuns).toHaveLength(1);
  expect(processorRuns[0]!.status).toBe("succeeded");
  expect(processorRuns[0]!.modeUsed).toBe("ai");

  // The packet the browser task emitted is what triggered the asset task's run — i.e. what
  // a real `AssetExecutor` (S5c+) would see through `RunHandle.trigger`.
  const triggerEventId = processorRuns[0]!.triggerEventId;
  expect(triggerEventId).not.toBeNull();
  const [triggerEvent] = await db.select().from(events).where(eq(events.eventId, triggerEventId!));
  expect(triggerEvent?.packet).toEqual({ hello: "world" });
});

it("dispatch to a (kind, mode) pair with no registration fails the run with a typed error", async () => {
  rig = await startRig();
  const db = rig.handle.db;

  const wf = await seedWorkflow(db, {
    tasks: { Orphan: { kind: "asset", mode: "ai" } },
  });

  await triggerTask(db, { taskId: wf.taskIds.Orphan! });
  const failed = await waitFor("the run to fail with no executor registered", async () => {
    const rows = await runsForTask(rig!, wf.taskIds.Orphan!);
    return rows[0]?.status === "failed" ? rows[0] : undefined;
  });
  expect(failed.error).toContain("no_executor_for(asset, ai)");
});

it("a task seeded without an explicit kind reads back as kind=browser", async () => {
  handle = await createMigratedTestDb();
  const wf = await seedWorkflow(handle.db, { tasks: { Plain: {} } });
  const [row] = await handle.db.select().from(tasks).where(eq(tasks.id, wf.taskIds.Plain!));
  expect(row?.kind).toBe("browser");
});

// -- Modes are authored as `stub`/`ai`; `compiled` is engine-assigned and `python` is retired --

async function publishError(handle: MigratedTestDb, graph: Graph): Promise<AppError> {
  const workflowId = await freshWorkflow(handle);
  const err = await publishVersion(handle.db, { workflowId, graph }, { schemaGenerator: noGenerator }).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(GRAPH_INVALID);
  return err as AppError;
}

/**
 * A document may not *claim* `compiled`: no script comes with a document, so a row published
 * that way would fail every run at "no active compiled script". The engine writes `compiled`
 * (promotion) and `publishVersion` carries it forward by content hash — never the author.
 */
it.each(["browser", "asset"] as const)("publishVersion rejects mode=compiled authored on a %s task", async (kind) => {
  handle = await createMigratedTestDb();
  const err = await publishError(handle, emptyGraph({ kind, mode: "compiled" }));
  expect(err.message).toContain('may not be published in mode "compiled"');
  expect(err.message).toContain("the engine assigns it");
});

/** `python` stopped being a mode: an asset task runs code through `python.run` on `ai`. */
it.each(["browser", "asset"] as const)("publishVersion rejects the retired mode=python on a %s task", async (kind) => {
  handle = await createMigratedTestDb();
  const err = await publishError(handle, emptyGraph({ kind, mode: "python" }));
  expect(err.message).toContain('may not be published in mode "python"');
  expect(err.message).toContain("python.run");
});

it("updateTask refuses the same modes publish refuses", async () => {
  handle = await createMigratedTestDb();
  const workflowId = await freshWorkflow(handle);
  const { taskIds } = await publishVersion(
    handle.db,
    { workflowId, graph: emptyGraph({ kind: "browser", mode: "ai" }) },
    { schemaGenerator: noGenerator },
  );
  for (const mode of ["compiled", "python"]) {
    const err = await updateTask(handle.db, { taskId: taskIds.T!, mode }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(GRAPH_INVALID);
  }
  await updateTask(handle.db, { taskId: taskIds.T!, mode: "stub" });
  const [row] = await handle.db.select().from(tasks).where(eq(tasks.id, taskIds.T!));
  expect(row?.mode).toBe("stub");
});

/**
 * The constraint is one exclusion, not a whitelist, and these cases are what say so. `mode`
 * is a bare `z.string()` by design so a test-only executor can claim a value without a
 * schema change — `scripted-browser.test.ts` publishes `mode='scripted'` through the real
 * publish path in five places. An earlier draft of the S5h migration closed the domain to
 * `('stub','ai','compiled','python')`, which would have rejected every one of them and taken
 * the whole S3b suite down with it. This is the assertion that would have caught that.
 * (`python` here is a bare row write — the *document* gate rejects it, the DB does not care.)
 */
it.each([
  ["an asset task written straight to python", "asset" as const, "python"],
  ["a browser task on a test-only mode", "browser" as const, "scripted"],
  ["a browser task promoted to compiled", "browser" as const, "compiled"],
])("the constraint permits %s", async (_label, kind, mode) => {
  handle = await createMigratedTestDb();
  const workflowId = await freshWorkflow(handle);
  const { taskIds } = await publishVersion(
    handle.db,
    { workflowId, graph: emptyGraph({ kind, mode: "ai" }) },
    { schemaGenerator: noGenerator },
  );

  await handle.db.update(tasks).set({ mode }).where(eq(tasks.id, taskIds.T!));
  const [row] = await handle.db.select().from(tasks).where(eq(tasks.id, taskIds.T!));
  expect(row?.mode).toBe(mode);
});
