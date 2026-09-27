import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { events, outbox, runs, workflowExecutions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflowExecution, dispatchEvent, finishRun, RUN_BUDGET_EXCEEDED, settleWorkflowExecutions, startRun, triggerTask } from "@tabductor/engine";
import { seedWorkflow } from "@tabductor/engine/testing";

let handle: MigratedTestDb;
beforeEach(async () => { handle = await createMigratedTestDb(); });
afterEach(async () => { await handle?.close(); });

it("bounds concurrent fan-out and duplicate deliveries without recursively publishing budget notices", async () => {
  const wf = await seedWorkflow(handle.db, {
    tasks: { Root: {}, A: {}, B: {}, C: {}, D: {}, Observer: {} },
    edges: [["Root", "work", "A"], ["Root", "work", "B"], ["Root", "work", "C"], ["Root", "work", "D"],
      ["Root", RUN_BUDGET_EXCEEDED, "Observer"]],
  });
  const executionId = await createWorkflowExecution(handle.db, { workflowId: wf.workflowId, maxRuns: 3 });
  const { event } = await triggerTask(handle.db, { taskId: wf.taskIds.Root!, executionId, type: "work" });
  await Promise.all([dispatchEvent(handle.db, event), dispatchEvent(handle.db, event)]);
  const attempts = await handle.db.select().from(runs);
  expect(attempts).toHaveLength(3);
  expect((await handle.db.select().from(workflowExecutions))[0]!.admittedRuns).toBe(3);
  const notices = await handle.db.select().from(events).where(eq(events.type, RUN_BUDGET_EXCEEDED));
  expect(notices).toHaveLength(2);
  for (const notice of notices) await dispatchEvent(handle.db, notice);
  expect(await handle.db.select().from(events).where(eq(events.type, RUN_BUDGET_EXCEEDED))).toHaveLength(2);
  for (const run of attempts) {
    const started = (await startRun(handle.db, run.id, undefined))!;
    await finishRun(handle.db, { runId: run.id, taskId: run.taskId, status: "succeeded", leaseGeneration: started.leaseGeneration });
  }
  await handle.db.update(outbox).set({ status: "dispatched" });
  await settleWorkflowExecutions(handle.db);
  expect((await handle.db.select().from(workflowExecutions))[0]!.status).toBe("failed");
});

it("counts retry attempts against the execution budget", async () => {
  const wf = await seedWorkflow(handle.db, { tasks: { Root: { retry: { max: 5 } } } });
  const executionId = await createWorkflowExecution(handle.db, { workflowId: wf.workflowId, maxRuns: 1 });
  const { dispatched } = await triggerTask(handle.db, { taskId: wf.taskIds.Root!, executionId });
  const started = (await startRun(handle.db, dispatched!.runId, undefined))!;
  await finishRun(handle.db, { runId: started.id, taskId: started.taskId, status: "failed", retry: true, leaseGeneration: started.leaseGeneration });
  expect(await handle.db.select().from(runs)).toHaveLength(1);
  expect(await handle.db.select().from(events).where(eq(events.type, RUN_BUDGET_EXCEEDED))).toHaveLength(1);
});

it("backfills admitted attempts when upgrading the previous execution schema", async () => {
  const wf = await seedWorkflow(handle.db, { tasks: { Root: {} } });
  await triggerTask(handle.db, { taskId: wf.taskIds.Root! });
  await handle.db.execute(sql`alter table workflow_executions drop column max_runs, drop column admitted_runs`);
  const migration = await readFile(new URL("../../packages/db/migrations/0033_pretty_madame_web.sql", import.meta.url), "utf8");
  await handle.db.execute(sql.raw(migration));
  expect((await handle.db.select().from(workflowExecutions))[0]).toMatchObject({ maxRuns: 1000, admittedRuns: 1 });
});
