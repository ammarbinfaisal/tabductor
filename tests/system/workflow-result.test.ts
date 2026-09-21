import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { outbox, runs, tasks } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createDispatcher } from "@tabductor/bus";
import { createResultExecutor, type Llm } from "@tabductor/agent";
import {
  createEngine, finishRun, graphSchema, readGraph, settleWorkflowExecutions, startRun,
  staticSchemaGenerator, triggerTask, type RunHandle,
} from "@tabductor/engine";
import { createCaller } from "../../apps/web/src/server/router.js";
import { createWorkflowControl } from "../../apps/web/src/server/workflow-mcp.js";

let db: MigratedTestDb;
beforeEach(async () => { db = await createMigratedTestDb(); });
afterEach(async () => { await db?.close(); });

async function fixture(schema?: Record<string, unknown> | boolean) {
  const ctx = { db: db.db, schemaGenerator: staticSchemaGenerator() };
  const api = createCaller(ctx);
  const workflowId = await api.workflow.create({ name: "Result test" });
  const graph = graphSchema.parse({ tasks: [
    { name: "root", kind: "browser", mode: "stub" },
    { name: "result", kind: "result", mode: "ai", prompt: "Return the count", resultSchema: schema },
  ] });
  const version = await api.workflow.publishVersion({ workflowId, graph });
  const started = await api.workflow.trigger({ workflowId });
  const root = (await startRun(db.db, started.runs[0]!.runId!, undefined))!;
  return { ctx, api, graph, workflowId, version, started, root,
    poll: () => api.workflow.status({ workflowId, executionId: started.executionId }) };
}

async function complete(root: Awaited<ReturnType<typeof fixture>>["root"], status: "succeeded" | "failed" = "succeeded") {
  await finishRun(db.db, { runId: root.id, taskId: root.taskId, leaseGeneration: root.leaseGeneration,
    status, ...(status === "failed" ? { error: "upstream failed" } : {}) });
}

it("waits for quiescence, queues one pinned finalizer across concurrent sweeps, and exposes durable JSON through API/MCP", async () => {
  const f = await fixture({ type: "object", properties: { count: { type: "integer" } }, required: ["count"] });
  expect(f.started.accepted).toBe(1);
  expect((await readGraph(db.db, f.version.versionId)).tasks.find((t) => t.kind === "result")?.resultSchema).toEqual(f.graph.tasks[1]!.resultSchema);
  await complete(f.root);
  await settleWorkflowExecutions(db.db);
  expect(await db.db.select().from(runs)).toHaveLength(1); // pending outbox
  expect(await f.poll()).toMatchObject({ status: "running", finished: false, resultReady: false, result: null });
  // A new version must not change the already accepted execution's prompt/schema.
  await f.api.workflow.publishVersion({ workflowId: f.workflowId,
    graph: { ...f.graph, tasks: f.graph.tasks.map((t) => t.kind === "result" ? { ...t, prompt: "New version", resultSchema: false } : t) } });
  await db.db.update(outbox).set({ status: "dispatched" });
  await Promise.all(Array.from({ length: 5 }, () => settleWorkflowExecutions(db.db)));
  const [finalizer] = await db.db.select().from(runs).where(eq(runs.taskId, f.version.taskIds.result!));
  expect(await db.db.select().from(runs)).toHaveLength(2);
  expect(finalizer?.workflowVersionId).toBe(f.version.versionId);
  const started = (await startRun(db.db, finalizer!.id, undefined))!;
  await finishRun(db.db, { runId: started.id, taskId: started.taskId, leaseGeneration: started.leaseGeneration,
    status: "succeeded", result: { count: 7 } });
  // The durable result is not exposed before terminal execution status.
  expect(await f.poll()).toMatchObject({ finished: false, resultReady: false, result: null });
  expect(await settleWorkflowExecutions(db.db)).toEqual([f.started.executionId]);
  expect(await settleWorkflowExecutions(db.db)).toEqual([]);
  const expected = { status: "succeeded", finished: true, resultReady: true, result: { count: 7 }, versionId: f.version.versionId };
  expect(await f.poll()).toMatchObject(expected);
  expect(await createWorkflowControl(f.ctx).status({ workflowId: f.workflowId, executionId: f.started.executionId })).toMatchObject(expected);
  await expect(triggerTask(db.db, { taskId: f.version.taskIds.result! })).rejects.toMatchObject({ code: "task_not_triggerable" });
  const other = await f.api.workflow.create({ name: "Other" });
  await expect(f.api.workflow.status({ workflowId: other, executionId: f.started.executionId })).rejects.toThrow("No execution");
  await expect(createCaller({ ...f.ctx, accountId: "acct_someone_else" }).workflow.status({ workflowId: f.workflowId, executionId: f.started.executionId })).rejects.toThrow();
});

it("repairs malformed model JSON using only this execution's evidence and returns a result even for failed work", async () => {
  const f = await fixture({ type: "object", required: ["count"], properties: { count: { type: "integer" } } });
  await complete(f.root, "failed");
  await db.db.update(outbox).set({ status: "dispatched" });
  await settleWorkflowExecutions(db.db);
  const [run] = await db.db.select().from(runs).where(eq(runs.taskId, f.version.taskIds.result!));
  const started = (await startRun(db.db, run!.id, undefined))!;
  const [task] = await db.db.select().from(tasks).where(eq(tasks.id, started.taskId));
  const completeModel = vi.fn<Llm["complete"]>()
    .mockResolvedValueOnce({ text: '{"count":"wrong"}', toolCalls: [], usage: { in: 1, out: 1 } })
    .mockResolvedValueOnce({ text: '{"count":0}', toolCalls: [], usage: { in: 1, out: 1 } });
  const executor = createResultExecutor({ db: db.db, llmFor: () => ({ complete: completeModel }) });
  const handle: RunHandle = { run: started, task: task!, trigger: null, signal: new AbortController().signal,
    emit: async () => { throw new Error("result must not emit"); }, declaredEmits: async () => [] };
  // A concurrent invocation has its own evidence, even in the same workflow/version.
  await triggerTask(db.db, { taskId: f.version.taskIds.root!, packet: { unrelated: "other_execution_only" } });
  const output = await executor.execute(handle);
  expect(output).toEqual({ ok: true, result: { count: 0 } });
  expect(completeModel).toHaveBeenCalledTimes(2);
  expect(completeModel.mock.calls[0]![0].tools).toEqual([]);
  expect(completeModel.mock.calls[0]![0].messages[0]!.content).toContain("upstream failed");
  expect(completeModel.mock.calls[0]![0].messages[0]!.content).not.toContain("other_execution_only");
  await finishRun(db.db, { runId: started.id, taskId: started.taskId, leaseGeneration: started.leaseGeneration,
    status: "succeeded", result: output.ok ? output.result : undefined });
  await settleWorkflowExecutions(db.db);
  expect(await f.poll()).toMatchObject({ status: "failed", finished: true, resultReady: true, result: { count: 0 } });
  completeModel.mockReset().mockResolvedValue({ text: "invalid JSON", toolCalls: [], usage: { in: 1, out: 1 } });
  expect(await executor.execute(handle)).toMatchObject({ ok: false, permanent: true, error: expect.stringContaining("result_generation_failed") });
  expect(completeModel).toHaveBeenCalledTimes(3);
});

it.each([{ value: null, schema: true, status: "succeeded" }, { value: { bad: true }, schema: false, status: "failed" }])(
  "engine validates finalizer output and represents JSON null distinctly ($status)", async ({ value, schema, status }) => {
    const f = await fixture(schema);
    await complete(f.root);
    await db.db.update(outbox).set({ status: "dispatched" });
    const dispatcher = createDispatcher(db);
    const engine = createEngine({ db: db.db, dispatcher, scheduler: false, watchdogIntervalMs: 20,
      executors: { "result:ai": { execute: async () => ({ ok: true, result: value }) } } });
    try {
      await engine.start();
      await vi.waitFor(async () => expect((await f.poll()).finished).toBe(true), { timeout: 3000 });
      expect(await f.poll()).toMatchObject({ status, resultReady: status === "succeeded", result: null });
      expect(await db.db.select().from(runs).where(and(eq(runs.executionId, f.started.executionId), eq(runs.taskId, f.version.taskIds.result!)))).toHaveLength(1);
    } finally { await engine.stop(); }
  },
);

it("does not persist a result from a revoked run lease", async () => {
  const f = await fixture();
  await complete(f.root);
  await db.db.update(outbox).set({ status: "dispatched" });
  await settleWorkflowExecutions(db.db);
  const [run] = await db.db.select().from(runs).where(eq(runs.taskId, f.version.taskIds.result!));
  const started = (await startRun(db.db, run!.id, undefined))!;
  await f.api.run.cancel({ runId: started.id });
  expect(await finishRun(db.db, { runId: started.id, taskId: started.taskId, leaseGeneration: started.leaseGeneration,
    status: "succeeded", result: { stale: true } })).toBeUndefined();
  await settleWorkflowExecutions(db.db);
  expect(await f.poll()).toMatchObject({ status: "cancelled", resultReady: false, result: null });
});

it("accepts one directing prompt and optional schema through MCP and the creation API", async () => {
  const graph = graphSchema.parse({ tasks: [{ name: "root", kind: "decision", mode: "ai", prompt: "Do the work" }] });
  const ctx = { db: db.db, schemaGenerator: staticSchemaGenerator(), graphCompiler: {
    compile: vi.fn(async () => ({ ok: true as const, artifact: { graph, store: null, proposedGrants: [] }, report: { checks: [], attempts: 1 } })),
  } };
  const control = createWorkflowControl(ctx);
  const schema = { type: "array", items: { type: "string" } };
  const published = await control.publish({ prompt: "Do the work and return every title", resultSchema: schema }) as { workflowId: string; versionId: string };
  expect(ctx.graphCompiler.compile).toHaveBeenCalledWith(expect.objectContaining({ intent: "Do the work and return every title", resultSchema: schema }));
  const current = await readGraph(db.db, published.versionId);
  expect(current.automationPrompt).toBe("Do the work and return every title");
  expect(current.tasks.find((task) => task.kind === "result")).toMatchObject({
    prompt: expect.stringContaining("Do the work and return every title"), resultSchema: schema, entry: false, emits: [], consumes: [], schedule: null,
  });
  await expect(createCaller(ctx).workflow.createFromPrompt({ prompt: "Test", resultSchema: { type: "invalid" } })).rejects.toThrow();
  expect(ctx.graphCompiler.compile).toHaveBeenCalledTimes(1);
  const updated = await control.update({ workflowId: published.workflowId, prompt: "Keep doing the work and return free-form JSON" }) as { versionId: string };
  expect((await readGraph(db.db, updated.versionId)).tasks.find((task) => task.kind === "result")).toMatchObject({
    prompt: expect.stringContaining("Keep doing the work and return free-form JSON"), resultSchema: null,
  });
});
