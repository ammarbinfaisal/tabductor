import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { runs, workflowExecutions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { finalizeWorkflow, type Llm } from "@tabductor/agent";
import { finishRun, settleWorkflowExecutions, startRun } from "@tabductor/engine";
import { createCaller } from "../../apps/web/src/server/router.js";
let db: MigratedTestDb;
beforeAll(async () => { db = await createMigratedTestDb(); });
afterAll(async () => { await db?.close(); });
async function fixture() {
  const api = createCaller({ db: db.db });
  const created = await api.workflow.createFromPrompt({ prompt: "Count products", resultSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } });
  const started = await api.workflow.trigger({ workflowId: created.workflowId });
  const run = (await startRun(db.db, started.runs[0]!.runId!, undefined))!;
  const poll = () => api.workflow.status({ workflowId: created.workflowId, executionId: started.executionId });
  return { ...created, ...started, run, poll };
}
it("finalizes quiescent runtime evidence once without queuing a result node", async () => {
  const f = await fixture();
  await settleWorkflowExecutions(db.db);
  expect((await f.poll()).finished).toBe(false);
  await finishRun(db.db, { runId: f.run.id, taskId: f.run.taskId, leaseGeneration: f.run.leaseGeneration, status: "succeeded", result: { count: 3 } });
  await Promise.all([settleWorkflowExecutions(db.db), settleWorkflowExecutions(db.db)]);
  const complete = vi.fn<Llm["complete"]>().mockResolvedValue({ text: JSON.stringify({ summary: "Found three products.", result: { count: 3 } }), toolCalls: [], usage: { in: 1, out: 1 } });
  await Promise.all([finalizeWorkflow({ db: db.db, llmFor: () => ({ complete }) }), finalizeWorkflow({ db: db.db, llmFor: () => ({ complete }) })]);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(await f.poll()).toMatchObject({ status: "succeeded", resultReady: true, result: { count: 3 }, summary: "Found three products." });
  expect(await db.db.select().from(runs).where(eq(runs.executionId, f.executionId))).toHaveLength(1);
});
it("retries schema-invalid finalization and keeps failed runtime status", async () => {
  const f = await fixture();
  await finishRun(db.db, { runId: f.run.id, taskId: f.run.taskId, leaseGeneration: f.run.leaseGeneration, status: "failed", error: "Page unavailable" });
  await settleWorkflowExecutions(db.db);
  const complete = vi.fn<Llm["complete"]>().mockResolvedValueOnce({ text: '{"summary":"Failed","result":{}}', toolCalls: [], usage: { in: 1, out: 1 } }).mockResolvedValue({ text: '{"summary":"Page unavailable; no products counted.","result":{"count":0}}', toolCalls: [], usage: { in: 1, out: 1 } });
  await finalizeWorkflow({ db: db.db, llmFor: () => ({ complete }) });
  expect((await f.poll()).resultReady).toBe(false);
  await finalizeWorkflow({ db: db.db, llmFor: () => ({ complete }) });
  expect(await f.poll()).toMatchObject({ status: "failed", resultReady: true, result: { count: 0 } });
});
it("fences a finalizer when the execution is cancelled during its model call", async () => {
  const f = await fixture();
  await finishRun(db.db, { runId: f.run.id, taskId: f.run.taskId, leaseGeneration: f.run.leaseGeneration, status: "succeeded" });
  await settleWorkflowExecutions(db.db);
  await finalizeWorkflow({ db: db.db, llmFor: () => ({ complete: async () => {
    await db.db.update(workflowExecutions).set({ status: "cancelled" }).where(eq(workflowExecutions.id, f.executionId));
    return { text: '{"summary":"Too late","result":{"count":9}}', toolCalls: [], usage: { in: 1, out: 1 } };
  } }) });
  expect(await f.poll()).toMatchObject({ status: "cancelled", resultReady: false });
});
