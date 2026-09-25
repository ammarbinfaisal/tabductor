import { expect, it, vi } from "vitest";
import { pythonFixture, testRunner } from "./python-test-support.js";
import type { Llm } from "./llm.js";
import { readSdkEvidence } from "@tabductor/compiler";
import { validatePythonCandidate } from "./python-validation.js";

it("returns schema-validated JSON from browser.ai and records a compilable operation", async () => {
  const f = pythonFixture();
  const runner = testRunner().open!({ runId: "browser-ai", leaseGeneration: 1 });
  const llm: Llm = { complete: vi.fn(async () => ({ text: '{"label":"approved","score":3}', toolCalls: [], usage: { in: 1, out: 1 } })) };
  const tool = f.tool({ pythonRunner: runner, llm });
  const result = await tool.execute({ source: "answer = browser.ai('Classify the current item', {'type':'object','properties':{'label':{'type':'string'},'score':{'type':'integer'}},'required':['label','score'],'additionalProperties':False})\nprint(answer['label'])\nworkflow.done()" });
  expect(result).toMatchObject({ ok: true, terminal: { outcome: "done" } });
  expect(llm.complete).toHaveBeenCalledWith(expect.objectContaining({ output: expect.objectContaining({ type: "json" }) }));
  const evidence = readSdkEvidence({ runId: "browser-ai", entries: f.entries });
  const ai = evidence.operations.find(operation => operation.name === "browser.ai");
  expect(ai?.result).toEqual({ ok: true, value: { label: "approved", score: 3 } });
  expect(ai?.args.schema_def).toEqual(expect.objectContaining({ type: "object" }));
  const done = evidence.operations.find(operation => operation.name === "workflow.done");
  expect(ai && done).toBeTruthy();
  const plan = { goal: "classify", guards: [], steps: [{ operationId: ai!.operationId, why: "semantic result" }, { operationId: done!.operationId, why: "finish" }], bindings: [], discarded: [], recoveryPrompt: "Inspect" };
  expect(await validatePythonCandidate(testRunner(), "def run(page, context, workflow):\n    browser.ai('Classify the current item', {'type':'object','properties':{'label':{'type':'string'},'score':{'type':'integer'}},'required':['label','score'],'additionalProperties':False})\n    workflow.done()", evidence, plan)).toEqual({ ok: true });
  await runner.close?.();
});

it("rejects a model result that does not satisfy the declared schema", async () => {
  const f = pythonFixture();
  const runner = testRunner().open!({ runId: "browser-ai-invalid", leaseGeneration: 1 });
  const llm: Llm = { complete: vi.fn(async () => ({ text: '{"score":"not-a-number"}', toolCalls: [], usage: { in: 1, out: 1 } })) };
  const tool = f.tool({ pythonRunner: runner, llm });
  const result = await tool.execute({ source: "answer = browser.ai('score it', {'type':'object','properties':{'score':{'type':'integer'}},'required':['score']})\nprint(answer)" });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("schema validation") });
  await runner.close?.();
});
