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
    report: { checks: [], attempts: 1 },
  }));
  const context = {
    db: handle.db,
    pool: handle.pool,
    schemaGenerator: staticSchemaGenerator({}),
    graphCompiler: { compile },
  };
  const control = createWorkflowControl(context);

  const published = await control.publish({ name: "Morning check", intent: "Check what is due" }) as {
    workflowId: string;
    versionId: string;
  };
  expect(published.workflowId).toMatch(/^wf_/);
  expect(JSON.stringify(published)).not.toContain("task_");

  const updated = await control.update({ workflowId: published.workflowId, intent: "Also retain a decision history" }) as {
    versionId: string;
  };
  expect(updated.versionId).not.toBe(published.versionId);
  expect(compile.mock.calls[1]?.[0].current?.graph.tasks).toHaveLength(1);

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
