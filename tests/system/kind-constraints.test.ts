import { afterEach, expect, it } from "vitest";
import { AppError } from "@tabductor/core";
import { tasks } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflow } from "@tabductor/engine";
import { GRAPH_INVALID, graphSchema, publishVersion, seedWorkflow, staticSchemaGenerator, updateTask, type Graph } from "@tabductor/engine/testing";
import { eq } from "drizzle-orm";

const generator = staticSchemaGenerator({});
let handle: MigratedTestDb | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const graph = (kind: "browser" | "decision", mode = "ai"): Graph => ({
  tasks: [{
    name: "T",
    kind,
    mode,
    prompt: "Do the internal work.",
    limits: {},
    emits: [],
    consumes: [],
    schedule: { cron: "* * * * *", tz: "UTC", missedPolicy: "skip", overlapPolicy: "skip", maxQueueDepth: 1, enabled: true },
    position: null,
  }],
  events: [],
});

it.each(["browser", "decision"] as const)("publishes a scheduled %s task", async (kind) => {
  handle = await createMigratedTestDb();
  const workflowId = await createWorkflow(handle.db, { name: "two kinds", userId: "user_test" });
  const published = await publishVersion(handle.db, { workflowId, graph: graph(kind) }, { schemaGenerator: generator });
  const [row] = await handle.db.select().from(tasks).where(eq(tasks.id, published.taskIds.T!));
  expect(row?.kind).toBe(kind);
});

it("rejects the removed asset kind at the graph boundary", () => {
  expect(() => graphSchema.parse({
    tasks: [{ ...graph("decision").tasks[0], kind: "asset" }],
    events: [],
  })).toThrow();
});

it.each(["browser", "decision"] as const)("rejects authored compiled mode on %s", async (kind) => {
  handle = await createMigratedTestDb();
  const workflowId = await createWorkflow(handle.db, { name: "modes", userId: "user_test" });
  const error = await publishVersion(
    handle.db,
    { workflowId, graph: graph(kind, "compiled") },
    { schemaGenerator: generator },
  ).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(GRAPH_INVALID);
});

it("keeps stub as a test-only mode and rejects retired python", async () => {
  handle = await createMigratedTestDb();
  const seeded = await seedWorkflow(handle.db, { tasks: { Test: { kind: "decision", mode: "stub" } } });
  const [row] = await handle.db.select().from(tasks).where(eq(tasks.id, seeded.taskIds.Test!));
  expect(row?.mode).toBe("stub");
  await expect(updateTask(handle.db, { taskId: seeded.taskIds.Test!, mode: "python" })).rejects.toMatchObject({
    code: GRAPH_INVALID,
  });
});
