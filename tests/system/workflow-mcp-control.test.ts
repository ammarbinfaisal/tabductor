import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { staticSchemaGenerator, type GraphCompiler } from "@tabductor/engine";
import { createCaller } from "../../apps/web/src/server/router.js";
import { createWorkflowControl } from "../../apps/web/src/server/workflow-mcp.js";

let handle: MigratedTestDb;

beforeAll(async () => {
  handle = await createMigratedTestDb();
});

afterAll(async () => {
  await handle?.close();
});

it("publishes, updates, triggers, and schedules without exposing task ids", async () => {
  const graph = {
    tasks: [{
      name: "internal-plan",
      kind: "decision" as const,
      mode: "ai",
      prompt: "Decide what work is due and remember the result.",
      limits: {},
      emits: [],
      consumes: [],
      schedule: null,
      position: null,
    }],
    events: [],
  };
  const compile = vi.fn<GraphCompiler["compile"]>(async () => ({
    ok: true,
    artifact: { graph, store: null, proposedGrants: [] },
    report: {
      checks: [{ pass: "P1", check: "graph_shape", status: "pass", message: "the graph is valid" }],
      attempts: 1,
    },
  }));
  const context = {
    db: handle.db,
    pool: handle.pool,
    schemaGenerator: staticSchemaGenerator({}),
    graphCompiler: { compile },
  };
  const control = createWorkflowControl(context);

  const published = await control.publish({ prompt: "Check what is due" }) as {
    workflowId: string;
    versionId: string;
  };
  expect(published.workflowId).toMatch(/^wf_/);
  expect(JSON.stringify(published)).not.toContain("task_");

  const updated = await control.update({ workflowId: published.workflowId, prompt: "Check what is due and retain a decision history" }) as {
    versionId: string;
  };
  expect(updated.versionId).not.toBe(published.versionId);
  expect(compile.mock.calls[1]?.[0]).not.toHaveProperty("current");

  const triggered = await control.trigger({ workflowId: published.workflowId }) as {
    accepted: number;
    runs: Array<{ runId: string | null }>;
  };
  expect(triggered.accepted).toBe(1);
  expect(triggered.runs[0]?.runId).toMatch(/^run_/);
  expect(JSON.stringify(triggered)).not.toContain("task_");

  const scheduled = await control.schedule({
    workflowId: published.workflowId,
    cron: "0 7 * * *",
    timezone: "Asia/Kolkata",
  }) as { versionId: string };
  expect(scheduled.versionId).not.toBe(updated.versionId);
  const current = await createCaller(context).workflow.get({ id: published.workflowId });
  expect(current.graph.tasks[0]?.schedule).toMatchObject({ cron: "0 7 * * *", tz: "Asia/Kolkata", enabled: true });
  expect(current.authoring?.report?.authoring.attempts).toBe(1);
  expect(current.authoring?.report?.authoring.checks.length).toBeGreaterThan(0);
});

it("rejects an MCP update compiled from a version that changed during authoring", async () => {
  let entered!: () => void;
  let resume!: () => void;
  const compiling = new Promise<void>((resolve) => { entered = resolve; });
  const release = new Promise<void>((resolve) => { resume = resolve; });
  const graph = { tasks: [], events: [] };
  const context = { db: handle.db, schemaGenerator: staticSchemaGenerator(), graphCompiler: {
    compile: async () => {
      entered();
      await release;
      return { ok: true as const, artifact: { graph, store: null, proposedGrants: [] }, report: { checks: [], attempts: 1 } };
    },
  } };
  const api = createCaller(context);
  const workflowId = await api.workflow.create({ name: "Concurrent update" });
  const initial = await api.workflow.publishVersion({ workflowId, graph });
  const update = createWorkflowControl(context).update({ workflowId, prompt: "Change the workflow" });
  await compiling;
  const winner = await api.workflow.publishVersion({ workflowId, expectedVersionId: initial.versionId, graph });
  resume();
  await expect(update).rejects.toThrow("published elsewhere");
  expect((await api.workflow.get({ id: workflowId })).versionId).toBe(winner.versionId);
});

it("retries a trigger request across concurrent calls and later publication without starting new work", async () => {
  const context = { db: handle.db, schemaGenerator: staticSchemaGenerator() };
  const api = createCaller(context);
  const workflowId = await api.workflow.create({ name: "Idempotent roots" });
  const graph = { contractVersion: 2 as const, externalInputs: [], systemInputs: [], maxRuns: 4,
    tasks: [{ logicalId: "stable-a", name: "Entry", entry: true, mode: "stub", consumes: [], emits: [] },
      { logicalId: "stable-b", name: "Not an entry", entry: false, mode: "stub", consumes: [], emits: [] }], events: [] };
  await api.workflow.publishVersion({ workflowId, graph });
  const requests = await Promise.all(Array.from({ length: 6 }, () => api.workflow.trigger({ workflowId, requestId: "same-request" })));
  expect(new Set(requests.map((r) => r.executionId)).size).toBe(1);
  expect(requests[0]!.accepted).toBe(1);
  await api.workflow.publishVersion({ workflowId, graph: { ...graph, tasks: [{ ...graph.tasks[0]!, name: "Renamed entry" }] } });
  expect(await api.workflow.trigger({ workflowId, requestId: "same-request" })).toEqual(requests[0]);
  expect((await api.workflow.trigger({ workflowId, requestId: "new-request" })).executionId).not.toBe(requests[0]!.executionId);
  const current = await api.workflow.get({ id: workflowId });
  expect(current.graph.tasks[0]).toMatchObject({ logicalId: "stable-a", name: "Renamed entry", entry: true });
  expect(current.graph).toMatchObject({ contractVersion: 2 });
});
