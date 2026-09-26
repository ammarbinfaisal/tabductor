import { afterEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { browserArtifactKey, newId, SCRIPT_RUNTIME_VERSION } from "@tabductor/core";
import { accounts, browserProfiles, browserSessions, browserSessionActivity, workflowExecutions,
  browserLearningJobs, browserPromptRevisions, compileJobs, compiledScripts, runs, tasks, taskState, traceEntries, type RunStatus } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { browserOperatingPrompt, latestBrowserPrompt, publishVersion, readGraph, seedWorkflow, staticSchemaGenerator, updateTask } from "@tabductor/engine";
import { activateScript, insertCandidateScript, promoteTask, recordCompiledRun } from "@tabductor/compiler";
import { claimBrowserLearning, createBrowserLearningWorker, dispatchLearningCompile, enqueueBrowserLearning } from "../../packages/agent/src/learning-loop.js";
import { createCompileLoop, createCompileWorker } from "../../packages/agent/src/compile-loop.js";
import { runAgentLoop } from "../../packages/agent/src/loop.js";
import { doneTool } from "../../packages/agent/src/tools.js";
import type { BrowserLearningResult } from "../../packages/agent/src/learning-evidence.js";
import type { LlmRequest } from "../../packages/agent/src/llm.js";

let database: MigratedTestDb | undefined;
afterEach(async () => { await database?.close(); database = undefined; });

async function fixture() {
  database = await createMigratedTestDb();
  const db = database.db;
  const wf = await seedWorkflow(db, { tasks: { Writer: { mode: "ai", prompt: "Save the requested record and verify it." } } });
  const taskId = wf.taskIds.Writer!;
  await db.update(tasks).set({ compiledPrompt: "Use the current input to save and verify the requested record." }).where(eq(tasks.id, taskId));
  const task = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  async function run(status: RunStatus = "succeeded", modeUsed = "ai", failedProbe = false) {
    const snapshot = await task();
    const [row] = await db.insert(runs).values({ id: newId("run"), taskId, workflowVersionId: wf.versionId, modeUsed, status,
      endedAt: status === "running" ? null : new Date() }).returning();
    const invocationId = "invocation", source = "def run(page, context, workflow):\n    page.goto(workflow.input['url'])\n    workflow.done()";
    const payloads: Record<string, unknown>[] = [
      { runtimeVersion: SCRIPT_RUNTIME_VERSION, browserVersion: "fixture" },
      { action: "sdk.invocation", invocationId, source, input: { url: "https://fixture.test", id: "previous-record" },
        language: "python", operationVersion: 3, apiVersion: "playwright-python-v1", helpers: [], api: [],
        evidenceScope: { taskId, contentHash: snapshot.contentHash } },
      { action: "sdk.operation", phase: "started", operationId: "open", invocationId, sequence: 1, name: "playwright.call", effect: false,
        args: { member: "goto", args: ["https://fixture.test"], kwargs: {} } },
      { action: "sdk.operation", phase: "finished", operationId: "open", invocationId, result: { ok: true, value: "editor visible" } },
      { action: "sdk.operation", phase: "started", operationId: "finish", invocationId, sequence: 2, name: "workflow.done", effect: true, args: {} },
      { action: "sdk.operation", phase: "finished", operationId: "finish", invocationId, result: { ok: status === "succeeded", value: null } },
    ];
    if (failedProbe) payloads.splice(2, 0,
      { action: "sdk.operation", phase: "started", operationId: "probe", invocationId, sequence: 0, name: "playwright.call", effect: false, args: { member: "count" } },
      { action: "sdk.operation", phase: "finished", operationId: "probe", invocationId, result: { ok: false, error: "read probe failed" } },
    );
    await db.insert(traceEntries).values(payloads.map((payloadJson, seq) => ({ runId: row!.id, seq, kind: seq === 0 ? "runtime" as const : "action" as const, payloadJson })));
    return row!;
  }
  function learned(runId: string, eligible = false, successSeq = 3): BrowserLearningResult {
    return { procedure: { steps: [{ instruction: "Open the requested editor using workflow.input.url.", evidence: [`${runId}:${successSeq}`] }],
      cautions: [], instructions: "Read back the saved value before finishing." }, deopt: null,
      compile: { eligible, reason: eligible ? "Straightforward observed work" : "Needs further exploration", evidence: [`${runId}:${successSeq}`] } };
  }
  const response = (result: BrowserLearningResult) => ({ text: JSON.stringify(result), toolCalls: [], usage: { in: 1, out: 1 } });
  const worker = (complete: (request: LlmRequest) => Promise<ReturnType<typeof response>>) => createBrowserLearningWorker({ db, llmFor: () => ({ complete }) });
  async function script() {
    const item = await insertCandidateScript(db, { taskId, source: "def run(page, context, workflow):\n    workflow.deopt(reason='Inspect current editor')",
      guardsMeta: { language: "python", apiVersion: "playwright-python-v1", compatibility: { runtimeVersion: SCRIPT_RUNTIME_VERSION, browserVersion: "fixture" },
        plan: { recoveryPrompt: "Inspect current editor", deopts: [{ id: "finish", prompt: "Judge and finish the current editor" }] } }, fromRuns: [] });
    await activateScript(db, item.id);
    await db.update(tasks).set({ mode: "compiled" }).where(eq(tasks.id, taskId));
    return item;
  }
  return { db, wf, taskId, task, run, learned, response, worker, script };
}

it("learns after settlement and starts a fresh execution with a bounded initial procedure and new input", async () => {
  const f = await fixture(), snapshot = await f.task(), source = await f.run("running");
  const hooks = createCompileLoop({ db: f.db });
  expect((await hooks.afterAiRun({ task: snapshot, run: source, ok: true })).enqueued).toBe(true);
  const complete = vi.fn(async () => f.response(f.learned(source.id)));
  const learner = f.worker(complete);
  expect(await learner.runOnce()).toBeNull();
  expect(complete).not.toHaveBeenCalled();
  await f.db.update(runs).set({ status: "succeeded", endedAt: new Date() }).where(eq(runs.id, source.id));
  await learner.runOnce();
  const prompt = await browserOperatingPrompt(f.db, snapshot);
  expect(prompt.revision).toBe(1);
  expect((await f.task()).prompt).toBe(snapshot.prompt);
  expect((await f.task()).contentHash).toBe(snapshot.contentHash);
  expect(await f.db.select().from(compileJobs)).toHaveLength(0);
  await runAgentLoop({ task: { prompt: prompt.prompt }, emits: [], trace: { record: async () => {}, flush: async () => {}, close: async () => {} },
    trigger: { type: "record", schema: {}, packet: { id: "next-record" } },
    tools: [doneTool()],
    llm: { complete: async request => {
      expect(request.system).toContain("next-record");
      expect(request.system).not.toContain("previous-record");
      return { toolCalls: [{ id: "done", name: "done", args: {} }], usage: { in: 1, out: 1 } };
    } } });
});

it("learns cautions from a failed run without replacing the last proven procedure", async () => {
  const f = await fixture(), first = await f.run();
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: first });
  await f.worker(async () => f.response(f.learned(first.id))).runOnce();
  const failed = await f.run("failed");
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: failed });
  const result = f.learned(failed.id, true);
  result.procedure!.instructions = "Wrong instructions from a failed attempt";
  result.procedure!.cautions = [{ instruction: "Inspect the result when completion fails.", evidence: [`${failed.id}:5`] }];
  await f.worker(async () => f.response(result)).runOnce();
  const current = await f.task();
  expect(current.compiledPrompt).toContain("Read back the saved value");
  expect(current.compiledPrompt).not.toContain("Wrong instructions");
  expect(current.compiledPrompt).toContain("Inspect the result when completion fails");
  expect(await f.db.select().from(compileJobs)).toHaveLength(0);
});

it.each([false, true])("updates scoped recovery instructions independently of source (planned=%s)", async planned => {
  const f = await fixture(), artifact = await f.script(), source = await f.run("succeeded", "compiled");
  const key = planned ? "planned:finish" : "recovery";
  await createCompileLoop({ db: f.db }).afterCompiledRun({ task: await f.task(), run: source, ok: true, deopted: true,
    plannedDeopted: planned, scriptId: artifact.id, scriptKey: browserArtifactKey(artifact), deoptKey: key });
  const result = f.learned(source.id);
  result.deopt = { prompt: "Inspect acknowledged writes and finish only the remaining record; do not replay the prefix.", evidence: [`${source.id}:3`] };
  await f.worker(async () => f.response(result)).runOnce();
  const prompt = await latestBrowserPrompt(f.db, f.taskId, (await f.task()).contentHash, "deopt", `${browserArtifactKey(artifact)}:${key}`);
  expect(prompt?.prompt).toContain("do not replay the prefix");
  const [unchanged] = await f.db.select().from(compiledScripts).where(eq(compiledScripts.id, artifact.id));
  expect(unchanged?.source).toBe(artifact.source);
  expect(unchanged?.status).toBe("active");
  expect((await f.task()).recentDeopts).toEqual([!planned]);
  expect(await f.db.select().from(compileJobs)).toHaveLength(0);
});

it("clean static successes create no learning jobs, while failures do", async () => {
  const f = await fixture(), artifact = await f.script(), hooks = createCompileLoop({ db: f.db });
  await hooks.afterCompiledRun({ task: await f.task(), run: await f.run("succeeded", "compiled"), ok: true, deopted: false, scriptId: artifact.id });
  expect(await f.db.select().from(browserLearningJobs)).toHaveLength(0);
  await hooks.afterCompiledRun({ task: await f.task(), run: await f.run("failed", "compiled"), ok: false, deopted: false,
    scriptId: artifact.id, scriptKey: browserArtifactKey(artifact) });
  expect(await f.db.select().from(browserLearningJobs)).toHaveLength(1);
});

it.each([[true, false], [false, false], [true, true]])("learner eligibility feeds the compiler and preserves prompts on refusal (valid=%s, existing=%s)", async (valid, existing) => {
  const f = await fixture(), artifact = existing ? await f.script() : undefined;
  const source = await f.run("succeeded", existing ? "compiled" : "ai");
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: source,
    context: artifact ? { scriptId: artifact.id, scriptKey: browserArtifactKey(artifact), deoptKey: "planned:finish", planned: true } : undefined });
  await f.worker(async () => f.response(f.learned(source.id, true))).runOnce();
  const [job] = await f.db.select().from(compileJobs);
  expect(job?.learningJobId).toBeTruthy();
  let turns = 0;
  const compiler = createCompileWorker({ db: f.db, validatePython: async () => valid ? { ok: true } : { ok: false, reason: "missing verification" },
    compileLlmFor: () => ({ complete: async () => ({ text: turns++ === 0 ? JSON.stringify({
      goal: "save", guards: [{ operationId: "open", condition: "editor visible" }],
      steps: [{ operationId: "finish", why: "verified completion" }], bindings: [], checkpoints: [], discarded: [], recoveryPrompt: "Inspect the editor",
    }) : "def run(page, context, workflow):\n    workflow.done()" }) }) });
  const outcome = await compiler.runOnce();
  expect(outcome?.result.ok).toBe(valid);
  expect((await f.task()).mode).toBe(valid ? "compiled" : "ai");
  const [finished] = await f.db.select().from(compileJobs);
  expect(finished?.status).toBe(valid ? "succeeded" : "refused");
  if (artifact) expect((await f.db.select().from(compiledScripts).where(eq(compiledScripts.id, artifact.id)))[0]?.status).toBe("invalidated");
});

it("incomplete evidence and unresolved effects block compilation even when the learner approves", async () => {
  const f = await fixture();
  for (const reason of ["redacted", "uncertain"]) {
    const source = await f.run();
    if (reason === "redacted") await f.db.update(traceEntries).set({ payloadJson: {
      action: "sdk.invocation", evidenceOmitted: true, operationVersion: 3,
    } }).where(and(eq(traceEntries.runId, source.id), eq(traceEntries.seq, 1)));
    else await f.db.insert(taskState).values({ taskId: f.taskId, key: `agent-code-progress:${source.id}`, value: { requiresReconciliation: true } });
    await enqueueBrowserLearning(f.db, { task: await f.task(), run: source });
    await f.worker(async () => f.response(f.learned(source.id, true))).runOnce();
  }
  expect(await f.db.select().from(compileJobs)).toHaveLength(0);
});

it("serializes jobs per node and fences a reclaimed worker's late response", async () => {
  const f = await fixture(), first = await f.run(), second = await f.run();
  const job = await enqueueBrowserLearning(f.db, { task: await f.task(), run: first });
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: second });
  expect(await enqueueBrowserLearning(f.db, { task: await f.task(), run: first })).toBeNull();
  let respond!: (value: ReturnType<typeof f.response>) => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const old = f.worker(async () => { started(); return new Promise(resolve => { respond = resolve; }); }).runOnce();
  await waiting;
  expect(await claimBrowserLearning(f.db)).toBeNull();
  await f.db.update(browserLearningJobs).set({ heartbeatAt: new Date(0) }).where(eq(browserLearningJobs.id, job!.id));
  await f.worker(async () => f.response(f.learned(first.id))).runOnce();
  const revision = (await f.task()).learningRevision;
  respond(f.response({ ...f.learned(first.id), procedure: null }));
  await old;
  expect((await f.task()).learningRevision).toBe(revision);
  const next = await claimBrowserLearning(f.db);
  expect(next?.runId).toBe(second.id);
});

it("rejects learning after an in-flight task edit and preserves the edit", async () => {
  const f = await fixture(), source = await f.run();
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: source });
  await f.worker(async () => {
    await updateTask(f.db, { taskId: f.taskId, prompt: "New task definition" });
    return f.response(f.learned(source.id, true));
  }).runOnce();
  expect((await f.task()).prompt).toBe("New task definition");
  expect((await f.task()).compiledPrompt).toBeNull();
  expect(await f.db.select().from(browserPromptRevisions)).toHaveLength(0);
  expect((await f.db.select().from(browserLearningJobs))[0]?.status).toBe("refused");
});

it("retries model failures independently and applies a revision only once", async () => {
  const f = await fixture(), source = await f.run();
  const job = await enqueueBrowserLearning(f.db, { task: await f.task(), run: source });
  await f.worker(async () => { throw new Error("model unavailable"); }).runOnce();
  expect((await f.db.select().from(browserLearningJobs))[0]).toMatchObject({ status: "queued", attempts: 1 });
  expect((await f.db.select().from(runs))[0]?.status).toBe("succeeded");
  await f.db.update(browserLearningJobs).set({ notBefore: new Date(0) }).where(eq(browserLearningJobs.id, job!.id));
  const worker = f.worker(async () => f.response(f.learned(source.id)));
  await worker.runOnce();
  expect(await worker.runOnce()).toBeNull();
  expect(await f.db.select().from(browserPromptRevisions)).toHaveLength(1);
});

it("carries compatible learning across publication and drops it for changed task intent", async () => {
  const f = await fixture(), source = await f.run();
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: source });
  await f.worker(async () => f.response(f.learned(source.id))).runOnce();
  const graph = await readGraph(f.db, f.wf.versionId);
  const next = await publishVersion(f.db, { workflowId: f.wf.workflowId, graph }, { schemaGenerator: staticSchemaGenerator({}) });
  const [carried] = await f.db.select().from(tasks).where(eq(tasks.workflowVersionId, next.versionId));
  expect(carried?.compiledPrompt).toContain("workflow.input.url");
  graph.tasks[0]!.prompt = "A different task";
  const changed = await publishVersion(f.db, { workflowId: f.wf.workflowId, graph }, { schemaGenerator: staticSchemaGenerator({}) });
  const [reset] = await f.db.select().from(tasks).where(eq(tasks.workflowVersionId, changed.versionId));
  expect(reset?.learningRevision).toBe(0);
});

it("rejects static replacement after another artifact became active", async () => {
  const f = await fixture(), old = await f.script();
  const candidate = await insertCandidateScript(f.db, { taskId: f.taskId, source: "candidate", fromRuns: [] });
  const newer = await insertCandidateScript(f.db, { taskId: f.taskId, source: "newer", fromRuns: [] });
  await activateScript(f.db, newer.id);
  const result = await promoteTask({ db: f.db }, { taskId: f.taskId, scriptId: candidate.id,
    expectContentHash: (await f.task()).contentHash, expectScriptId: old.id });
  expect(result.promoted).toBe(false);
  expect((await f.db.select().from(compiledScripts).where(eq(compiledScripts.status, "active")))[0]?.id).toBe(newer.id);
  expect(await recordCompiledRun({ db: f.db }, await f.task(), { deopted: true, scriptId: old.id })).toEqual({ demoted: false, deoptsInWindow: 0 });
});

it("starts a new learned procedure after an edit without reusing old revisions or revision numbers", async () => {
  const f = await fixture(), first = await f.run();
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: first });
  await f.worker(async () => f.response(f.learned(first.id))).runOnce();
  await updateTask(f.db, { taskId: f.taskId, prompt: "Inspect the destination only" });
  expect((await browserOperatingPrompt(f.db, await f.task())).revision).toBe(0);
  const second = await f.run();
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: second });
  const result = f.learned(second.id);
  result.procedure!.instructions = "Read the destination without modifying it.";
  await f.worker(async request => {
    expect(JSON.parse(request.messages[0]!.content).previous).toBeNull();
    return f.response(result);
  }).runOnce();
  expect((await f.task()).learningRevision).toBe(2);
  expect((await f.task()).compiledPrompt).not.toContain("Read back the saved value");
  expect(await f.db.select().from(browserPromptRevisions)).toHaveLength(2);
});

it("retains an approved compilation request until the node's busy compile queue is free", async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++) {
    const source = await f.run();
    await enqueueBrowserLearning(f.db, { task: await f.task(), run: source });
    await f.worker(async () => f.response(f.learned(source.id, true))).runOnce();
  }
  expect(await f.db.select().from(compileJobs)).toHaveLength(1);
  const pending = (await f.db.select().from(browserLearningJobs)).filter(job => !job.compileJobId);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.compileRequested).toBe(true);
  await f.db.update(compileJobs).set({ status: "refused" });
  await dispatchLearningCompile(f.db);
  expect(await f.db.select().from(compileJobs)).toHaveLength(2);
  expect((await f.db.select().from(browserLearningJobs)).every(job => !!job.compileJobId)).toBe(true);
});

it("carries deopt revisions with the same artifact and ignores incompatible runtime learning", async () => {
  const f = await fixture(), artifact = await f.script(), source = await f.run("succeeded", "compiled");
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: source,
    context: { scriptId: artifact.id, scriptKey: browserArtifactKey(artifact), deoptKey: "planned:finish", planned: true } });
  const result = f.learned(source.id);
  result.deopt = { prompt: "Finish only the pending semantic judgment.", evidence: [`${source.id}:3`] };
  await f.worker(async () => f.response(result)).runOnce();
  const graph = await readGraph(f.db, f.wf.versionId);
  const version = await publishVersion(f.db, { workflowId: f.wf.workflowId, graph }, { schemaGenerator: staticSchemaGenerator({}) });
  const [task] = await f.db.select().from(tasks).where(eq(tasks.workflowVersionId, version.versionId));
  const [copied] = await f.db.select().from(compiledScripts).where(eq(compiledScripts.taskId, task!.id));
  expect(copied?.id).not.toBe(artifact.id);
  expect(browserArtifactKey(copied!)).toBe(browserArtifactKey(artifact));
  expect((await latestBrowserPrompt(f.db, task!.id, task!.contentHash, "deopt", `${browserArtifactKey(copied!)}:planned:finish`))?.prompt).toBe(result.deopt.prompt);
  await f.db.update(tasks).set({ learningRuntimeVersion: "old-runtime" }).where(eq(tasks.id, f.taskId));
  const fallback = await browserOperatingPrompt(f.db, await f.task());
  expect(fallback.revision).toBe(0);
});

it("human assistance permits prompt learning but cannot authorize static compilation", async () => {
  const f = await fixture(), source = await f.run();
  const accountId = newId("account"), profileId = newId("profile"), sessionId = newId("session"), executionId = newId("execution");
  await f.db.insert(accounts).values({ id: accountId, name: "Learning test" });
  await f.db.insert(browserProfiles).values({ id: profileId, accountId, name: "Profile" });
  await f.db.insert(workflowExecutions).values({ id: executionId, workflowId: f.wf.workflowId, workflowVersionId: f.wf.versionId, maxHops: 10 });
  await f.db.insert(browserSessions).values({ id: sessionId, profileId, accountId, executionId });
  await f.db.insert(browserSessionActivity).values({ sessionId, kind: "takeover_started" });
  await f.db.update(runs).set({ executionId }).where(eq(runs.id, source.id));
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: source });
  await f.worker(async request => {
    expect(JSON.parse(request.messages[0]!.content).outcome.assisted).toBe(true);
    return f.response(f.learned(source.id, true));
  }).runOnce();
  expect(await f.db.select().from(compileJobs)).toHaveLength(0);
});

it("the learner can approve a successful path with a recovered read failure", async () => {
  const f = await fixture(), source = await f.run("succeeded", "ai", true);
  await enqueueBrowserLearning(f.db, { task: await f.task(), run: source });
  await f.worker(async request => {
    expect(JSON.parse(request.messages[0]!.content).statistics.failedOperations).toBe(1);
    return f.response(f.learned(source.id, true, 5));
  }).runOnce();
  expect(await f.db.select().from(compileJobs)).toHaveLength(1);
});
