import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { runs, tasks, workflowExecutions, runRecordOutcomes, cdpEndpoints } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { seedWorkflow, type RunHandle } from "@tabductor/engine";
import { acquireBrowserContinuity } from "../../packages/agent/src/browser-continuity.js";
import { createContextHistory } from "../../packages/agent/src/context-history.js";
import { createRunWorkspace } from "../../packages/agent/src/workspace.js";
import { pythonFixture } from "../../packages/agent/src/python-test-support.js";
import { runAgentLoop } from "../../packages/agent/src/loop.js";
import { localPythonRunnerForTest } from "../../packages/agent/src/python-runner.js";
import { createAgentExecutor, createCompiledExecutor } from "@tabductor/agent";
import { createEndpointPool, playwrightDriver } from "@tabductor/browser";
import { launchChrome } from "@tabductor/testkit";
import { AllowAllGate } from "@tabductor/policy";
import { insertCandidateScript, activateScript } from "@tabductor/compiler";

let dbHandle: MigratedTestDb | undefined;
afterEach(async () => { await dbHandle?.close(); dbHandle = undefined; });
async function fixture() {
  dbHandle = await createMigratedTestDb();
  const db = dbHandle.db;
  const wf = await seedWorkflow(db, { tasks: { Writer: { mode: "ai" }, Other: { mode: "ai" } } });
  async function execution() {
    const id = randomUUID();
    await db.insert(workflowExecutions).values({ id, workflowId: wf.workflowId, workflowVersionId: wf.versionId, maxHops: 20 });
    return id;
  }
  const executionId = await execution();
  async function handle(record: string, opts: { taskId?: string; executionId?: string } = {}): Promise<RunHandle> {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, opts.taskId ?? wf.taskIds.Writer!));
    const [run] = await db.insert(runs).values({ id: randomUUID(), taskId: task!.id, workflowVersionId: wf.versionId,
      executionId: opts.executionId ?? executionId, modeUsed: "ai", status: "running", leaseGeneration: 1 }).returning();
    return { run: run!, task: task!, signal: new AbortController().signal,
      trigger: { eventId: randomUUID(), executionId, type: "Record", packet: { id: record }, sourceTaskId: null,
        sourceRunId: null, causationId: null, occurredAt: new Date(), traceparent: null },
      recordInput: {key:"id",packet:{id:record}},
      declaredEmits: async () => [], emit: async () => null };
  }
  return { db, wf, handle, execution };
}

it("continues learned Python procedure, files and conversation with the next input", async () => {
  const f = await fixture();
  const bytes = new Map<string, Buffer>();
  const blobs = { put: async (value: Buffer) => { const ref = createHash("sha256").update(value).digest("hex"); bytes.set(ref, value); return ref; },
    get: async (ref: string) => bytes.get(ref)! };
  const written: string[] = [], verified: string[] = [];
  let previousRunId: string | undefined;
  for (const id of ["record-one", "record-two"]) {
    const handle = await f.handle(id);
    const continuity = (await acquireBrowserContinuity(f.db, handle, "python"))!;
    const history = createContextHistory(blobs, continuity.context);
    const workspace = createRunWorkspace(blobs, continuity.workspace);
    const recorder = { record: vi.fn(async () => {}), flush: async () => {}, close: async () => {} };
    let currentVerified = false;
    const fixture = pythonFixture();
    fixture.calls.mockImplementation(async call => {
      if (call.member === "fill") { expect(call.args[1]).toBe(id); written.push(id); return null; }
      if (call.member === "evaluate") { expect(written).toContain(id); currentVerified = true; verified.push(id); return id; }
      return null;
    });
    const tool = fixture.tool({contextHistory:history,workspace,memory:continuity.memory,input:handle.trigger!.packet,
      recordCompletionError:async()=>currentVerified?null:"current record verification missing"});
    let turns = 0;
    const result = await runAgentLoop({ task: { prompt: "Save the current record" }, trigger: { type: "Record", packet: { id }, schema: {} },
      emits: [], tools: [tool], trace: recorder, contextHistory: history,
      browserContinuation: continuity.handoff,
      llm: { complete: async request => {
        expect(request.system).toContain(id);
        if (id === "record-one") {
          expect(turns++, JSON.stringify(request.messages.at(-1))).toBe(0);
          return { toolCalls: [{ id: "learn", name: "browser.python", args: { source:
            ["open('procedure.py','w').write(" + JSON.stringify('def save(page, workflow):\n    page.fill("#id", workflow.input["id"])\n    assert page.evaluate("() => window.savedId") == workflow.input["id"]\n') + ")",
              "import runpy", "runpy.run_path('procedure.py')['save'](page, workflow)", "workflow.done()"].join("\n") } }], usage: { in: 1, out: 1 } };
        }
        const wire = JSON.stringify(request.messages);
        expect(wire).toContain("procedure.py");
        expect(wire).not.toContain("record-one");
        expect(wire).not.toContain(previousRunId);
        expect(wire).not.toContain("editor-for-record-two");
        expect(request.system).toContain("A previous done call does not finish the current run");
        // Historical success must not satisfy this record's completion gate.
        return { toolCalls: [{ id: `reuse-${turns}`, name: "browser.python", args: { source: turns++ === 0
          ? "workflow.done()" : "import runpy\nrunpy.run_path('procedure.py')['save'](page, workflow)\nworkflow.done()" } }], usage: { in: 1, out: 1 } };
      } } });
    expect(result.outcome).toBe("done");
    expect(turns).toBe(id === "record-one" ? 1 : 2);
    await continuity.memory.set({ facts: ["Use procedure.py save(page, workflow)"], pending: [], interactions: [{ operation: "write" }] });
    await f.db.insert(runRecordOutcomes).values({ runId: handle.run.id, status: "saved", reason: `Verified ${id}` });
    await continuity.release(true);
    previousRunId = handle.run.id;
  }
  expect(written).toEqual(["record-one", "record-two"]);
  expect(verified).toEqual(written);
  const third = (await acquireBrowserContinuity(f.db, await f.handle("record-three"), "python"))!;
  expect(await third.memory.get()).toEqual({ facts: ["Use procedure.py save(page, workflow)"], pending: [] });
  expect(third.handoff.previous).toMatchObject({ runId: previousRunId, recordKey: "record-two", recordStatus: "saved" });
  await third.release(true);
});

it("serializes competing records, cancels waiters, and fences old stores after handoff", async () => {
  const f = await fixture(), first = await f.handle("first"), second = await f.handle("second");
  const a = (await acquireBrowserContinuity(f.db, first, "python"))!;
  await a.context.set({ summary: "learned editor" });
  const abort = new AbortController();
  const cancelled = acquireBrowserContinuity(f.db, { ...second, signal: abort.signal }, "python");
  const rejection = expect(cancelled).rejects.toThrow();
  await delay(50); abort.abort(); await rejection;
  let acquired = false;
  const waiting = acquireBrowserContinuity(f.db, second, "python").then(value => { acquired = true; return value!; });
  await delay(300); expect(acquired).toBe(false);
  await a.release(true);
  const b = await waiting;
  expect(await b.context.get()).toEqual({ summary: "learned editor" });
  await expect(a.context.set({ stale: true })).rejects.toThrow("another run");
  await expect(a.workspace.get()).rejects.toThrow("another run");
  await a.release(false);
  await b.memory.set({ facts: ["new owner"] });
  expect(await b.memory.get()).toEqual({ facts: ["new owner"] });
  await b.release(true);
});

it("recovers retained state after worker lease replacement and a failed record", async () => {
  const f = await fixture(), first = await f.handle("first");
  const a = (await acquireBrowserContinuity(f.db, first, "python"))!;
  await a.context.set({ ref: "unfinished-row-evidence" });
  await a.memory.set({ facts: ["editor found"], interactions: [{ operation: "write" }] });
  const [reclaimed] = await f.db.update(runs).set({ leaseGeneration: 2 }).where(eq(runs.id, first.run.id)).returning();
  const resumed = (await acquireBrowserContinuity(f.db, { ...first, run: reclaimed! }, "python"))!;
  expect(resumed.handoff).toMatchObject({ resumed: true, previous: { outcome: "interrupted" } });
  expect(await resumed.context.get()).toEqual({ ref: "unfinished-row-evidence" });
  expect(await resumed.memory.get()).toHaveProperty("interactions");
  await expect(a.context.set({ bad: true })).rejects.toThrow("ownership ended");
  await a.release(true);
  await f.db.update(runs).set({ status: "failed" }).where(eq(runs.id, first.run.id));
  const next = (await acquireBrowserContinuity(f.db, await f.handle("next"), "python"))!;
  expect(next.handoff).toMatchObject({ resumed: false, previous: { recordKey: "first", outcome: "interrupted" } });
  expect(await next.context.get()).toEqual({ ref: "unfinished-row-evidence" });
  expect(await next.memory.get()).toEqual({ facts: ["editor found"] });
  await resumed.release(false);
  await next.context.set({ ref: "next-owner" });
  await next.release(true);
});

it("isolates tasks, executions, definitions and language; supports untracked browser tasks", async () => {
  const f = await fixture(), first = await f.handle("first");
  const original = (await acquireBrowserContinuity(f.db, first, "python"))!;
  await original.context.set({ ref: "private" }); await original.release(true);
  const other = await f.handle("other");
  for (const [handle, language] of [
    [await f.handle("task", { taskId: f.wf.taskIds.Other! }), "python"],
    [await f.handle("execution", { executionId: await f.execution() }), "python"],
    [{ ...other, task: { ...other.task, contentHash: "changed" } }, "python"],
    [other, "javascript"],
  ] as const) {
    const state = (await acquireBrowserContinuity(f.db, handle, language))!;
    expect(await state.context.get()).toBeNull(); expect(state.handoff.previous).toBeNull(); await state.release(true);
  }
  const untracked = (await acquireBrowserContinuity(f.db, {...other, recordInput:undefined}, "python"))!;
  expect(untracked.handoff.recordKey).toBeNull();
  await untracked.release(true);
  expect(await acquireBrowserContinuity(f.db, {...other, task:{...other.task,kind:"decision"}}, "python")).toBeUndefined();
});

it("wires continuity through AI execution and compiled fallback without exposing checkpoint APIs", async () => {
  const f = await fixture(), chrome = await launchChrome();
  const data = new Map<string, Buffer>();
  const blobs = { put: async (value: Buffer) => { const ref = createHash("sha256").update(value).digest("hex"); data.set(ref, value); return ref; },
    get: async (ref: string) => data.get(ref)! };
  const endpointId = randomUUID();
  await f.db.insert(cdpEndpoints).values({ id: endpointId, wsUrl: chrome.wsUrl });
  const pool = createEndpointPool({ db: f.db, driver: {async connect(url) {
    const conn = await playwrightDriver.connect(url);
    return {...conn, async createPage(options) {
      const page = await conn.createPage(options);
      page.proxy = pythonFixture().session.page.proxy;
      return page;
    }};
  }} });
  const requests: string[] = [];
  const deps = { db: f.db, blobs, pool, pythonRunner:localPythonRunnerForTest(fileURLToPath(new URL("../../vendor/browser-harness/src/browser_harness/tabductor_runner.py",import.meta.url))), gate: new AllowAllGate({ navAllowlist: [] }), endpointFor: async () => endpointId,
    llmFor: () => ({ complete: async (request: import("@tabductor/agent").LlmRequest) => {
      const failed = request.messages.at(-1)?.toolResults?.find(result => !result.result.ok);
      if (failed) throw new Error(JSON.stringify(failed.result));
      requests.push(JSON.stringify(request.messages));
      expect(requests.length).toBeLessThanOrEqual(2);
      return { toolCalls: [{ id: `record-${requests.length}`, name: "browser.python", args: { source: requests.length === 1
        ? `open('procedure.txt','w').write('learned editor sequence')
workflow.memory.set(facts=['use procedure.txt'],pending=[])
workflow.done()`
        : `assert open('procedure.txt').read() == 'learned editor sequence'
assert 'use procedure.txt' in workflow.memory.get()['facts']
assert not any('checkpoint' in name for name in workflow.describe()['workflow'])
assert workflow.input['id'] == 'second'
workflow.done()` } }], usage: { in: 1, out: 1 } };
    } }) };
  try {
    const first = await f.handle("first");
    expect(await createAgentExecutor(deps).execute(first)).toEqual({ ok: true });
    const script = await insertCandidateScript(f.db, { taskId: first.task.id, source: "export default async api => api.run.deopt({reason:'recover'})",
      guardsMeta: { compatibility: { browserVersion: "changed-browser", runtimeVersion: -1 } }, fromRuns: [first.run.id] });
    await activateScript(f.db, script.id);
    const second = await f.handle("second");
    second.task.limitsJson = first.task.limitsJson;
    expect(await createCompiledExecutor(deps).execute(second)).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toContain(first.run.id);
    expect(requests[1]).toContain("learned editor sequence");
  } finally { await chrome.close(); }
});
