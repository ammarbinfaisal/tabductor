import { afterEach, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { events, outbox, runs, workflowExecutions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  BROWSER_OUTCOME_UNCERTAIN, createWorkflowExecution, dispatchEvent, finishRun,
  recoverStaleRuns, scheduleRetry, seedWorkflow, settleWorkflowExecutions, startRun, triggerTask,
} from "@tabductor/engine";

let handle: MigratedTestDb;
beforeEach(async () => { handle = await createMigratedTestDb(); });
afterEach(async () => { await handle?.close(); });

it("holds completion for pending delivery and descendants, then settles exactly once", async () => {
  const wf = await seedWorkflow(handle.db, {
    tasks: { Root: {}, Child: {} }, edges: [["Root", "work.requested", "Child"]],
  });
  const { event, dispatched } = await triggerTask(handle.db, { taskId: wf.taskIds.Root!, type: "work.requested" });
  const root = (await startRun(handle.db, dispatched!.runId, undefined))!;
  await finishRun(handle.db, { runId: root.id, taskId: root.taskId, status: "succeeded", leaseGeneration: root.leaseGeneration });
  expect(await settleWorkflowExecutions(handle.db)).toEqual([]);
  const [child] = await dispatchEvent(handle.db, event);
  await handle.db.update(outbox).set({ status: "dispatched" });
  expect(await settleWorkflowExecutions(handle.db)).toEqual([]);
  const childRun = (await startRun(handle.db, child!.runId, undefined))!;
  await finishRun(handle.db, { runId: childRun.id, taskId: childRun.taskId, status: "succeeded", leaseGeneration: childRun.leaseGeneration });
  expect(await settleWorkflowExecutions(handle.db)).toEqual([]); // completion system event still pending
  await handle.db.update(outbox).set({ status: "dispatched" });
  expect(await settleWorkflowExecutions(handle.db)).toEqual([event.executionId]);
  expect(await settleWorkflowExecutions(handle.db)).toEqual([]);
  const [execution] = await handle.db.select().from(workflowExecutions);
  expect(execution).toMatchObject({ status: "succeeded", workflowVersionId: wf.versionId });
  expect(execution!.endedAt).not.toBeNull();
});

it("creates retries atomically with failure and counts the final attempt's result", async () => {
  const wf = await seedWorkflow(handle.db, { tasks: { Root: { retry: { max: 2, backoff_ms: 500 } } } });
  const { event, dispatched } = await triggerTask(handle.db, { taskId: wf.taskIds.Root! });
  const root = (await startRun(handle.db, dispatched!.runId, undefined))!;
  await finishRun(handle.db, { runId: root.id, taskId: root.taskId, status: "failed", retry: true, leaseGeneration: root.leaseGeneration });
  const all = await handle.db.select().from(runs);
  expect(all).toHaveLength(2);
  const retry = all.find((row) => row.attempt === 1)!;
  expect(retry.executionId).toBe(event.executionId);
  await handle.db.update(outbox).set({ status: "dispatched" });
  expect(await settleWorkflowExecutions(handle.db)).toEqual([]);
  const [task] = await handle.db.query.tasks.findMany();
  const ids = await Promise.all(Array.from({ length: 4 }, () => scheduleRetry(handle.db, { run: root, task: task! })));
  expect(new Set(ids)).toEqual(new Set([retry.id]));
  expect(await handle.db.select().from(runs)).toHaveLength(2);
  await handle.db.update(runs).set({ notBefore: null }).where(eq(runs.id, retry.id));
  const started = (await startRun(handle.db, retry.id, undefined))!;
  await finishRun(handle.db, { runId: started.id, taskId: started.taskId, status: "succeeded", leaseGeneration: started.leaseGeneration });
  await handle.db.update(outbox).set({ status: "dispatched" });
  expect(await settleWorkflowExecutions(handle.db)).toEqual([event.executionId]);
  expect((await handle.db.select().from(workflowExecutions))[0]!.status).toBe("succeeded");
});

it("rolls back the entire trigger when root insertion fails", async () => {
  const wf = await seedWorkflow(handle.db, { tasks: { Root: {} } });
  await handle.db.execute(sql`create function reject_run() returns trigger language plpgsql as $$
    begin raise exception 'injected root failure'; end $$`);
  await handle.db.execute(sql`create trigger reject_run before insert on runs for each row execute function reject_run()`);
  await expect(triggerTask(handle.db, { taskId: wf.taskIds.Root! })).rejects.toMatchObject({ cause: { message: "injected root failure" } });
  expect(await handle.db.select().from(workflowExecutions)).toHaveLength(0);
  expect(await handle.db.select().from(events)).toHaveLength(0);
  expect(await handle.db.select().from(outbox)).toHaveLength(0);
});

it("rolls failure back if its retry cannot be inserted", async () => {
  const wf = await seedWorkflow(handle.db, { tasks: { Root: { retry: { max: 1 } } } });
  const { dispatched } = await triggerTask(handle.db, { taskId: wf.taskIds.Root! });
  const root = (await startRun(handle.db, dispatched!.runId, undefined))!;
  await handle.db.execute(sql`create function reject_retry() returns trigger language plpgsql as $$
    begin if new.attempt > 0 then raise exception 'injected retry failure'; end if; return new; end $$`);
  await handle.db.execute(sql`create trigger reject_retry before insert on runs for each row execute function reject_retry()`);
  await expect(finishRun(handle.db, { runId: root.id, taskId: root.taskId, status: "failed", retry: true, leaseGeneration: root.leaseGeneration }))
    .rejects.toMatchObject({ cause: { message: "injected retry failure" } });
  expect((await handle.db.select().from(runs))[0]!.status).toBe("running");
  expect(await handle.db.select().from(events).where(eq(events.type, "run.failed"))).toHaveLength(0);
});

it("rejects a version belonging to another workflow", async () => {
  const first = await seedWorkflow(handle.db, { tasks: { Root: {} } });
  const second = await seedWorkflow(handle.db, { tasks: { Root: {} } });
  await expect(createWorkflowExecution(handle.db, { workflowId: first.workflowId, workflowVersionId: second.versionId }))
    .rejects.toThrow("execution version must belong to its workflow");
});

it("never falls back to legacy routing for a foreign or terminal execution", async () => {
  const first = await seedWorkflow(handle.db, { tasks: { Root: {} } });
  const second = await seedWorkflow(handle.db, { tasks: { Root: {} } });
  const executionId = await createWorkflowExecution(handle.db, { workflowId: first.workflowId });
  await expect(triggerTask(handle.db, { taskId: second.taskIds.Root!, executionId })).rejects.toMatchObject({ code: "task_not_triggerable" });
  await handle.db.update(workflowExecutions).set({ status: "succeeded" }).where(eq(workflowExecutions.id, executionId));
  await expect(triggerTask(handle.db, { taskId: first.taskIds.Root!, executionId })).rejects.toMatchObject({ code: "task_not_triggerable" });
  expect(await handle.db.select().from(events)).toHaveLength(0);
});

it("does not automatically repeat a browser run abandoned during an uncertain action", async () => {
  const wf = await seedWorkflow(handle.db, { tasks: { Root: { retry: { max: 3 } } } });
  const { dispatched } = await triggerTask(handle.db, { taskId: wf.taskIds.Root! });
  await startRun(handle.db, dispatched!.runId, undefined);
  await handle.db.update(runs).set({ modeUsed: "ai", heartbeatAt: sql`now() - interval '10 minutes'` });
  const recovered = await recoverStaleRuns(handle.db, 1000);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]!.error).toBe(BROWSER_OUTCOME_UNCERTAIN);
  expect(await handle.db.select().from(runs)).toHaveLength(1);
});
