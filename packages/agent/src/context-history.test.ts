import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError, estimateModelInput } from "@tabductor/core";
import { contextOperations, createContextHistory } from "./context-history.js";
import { prepareContext } from "./context-compaction.js";
import { pythonFixture } from "./python-test-support.js";
import { defineTool } from "./tools.js";
import { localPythonRunnerForTest } from "./python-runner.js";
import { runAgentLoop } from "./loop.js";
import { toModelMessages } from "./llm-live.js";
import type { LlmMessage, LlmRequest } from "./llm.js";

function fixture() {
  let saved: unknown;
  const data = new Map<string, Buffer>();
  const blobs = { put: async (bytes: Buffer) => { const ref = createHash("sha256").update(bytes).digest("hex"); data.set(ref, bytes); return ref; }, get: async (ref: string) => data.get(ref)! };
  const store = { get: async () => saved, set: async (value: unknown) => { saved = value; } };
  return { history: createContextHistory(blobs, store), restore: () => createContextHistory(blobs, store), data };
}
const trace = () => ({ record: vi.fn(async () => {}), flush: async () => {}, close: async () => {} });
const runner = () => localPythonRunnerForTest(fileURLToPath(new URL("../../../vendor/browser-harness/src/browser_harness/tabductor_runner.py", import.meta.url)));

it("sends only the direct Python tool result to the next model invocation",async()=>{
  const f=fixture(), browser=pythonFixture();let turns=0;
  const tool=browser.tool({contextHistory:f.history});
  const result=await runAgentLoop({llm:{complete:async request=>{
    if(turns++===0)return {toolCalls:[{id:'read',name:'browser.python',args:{source:"page.title()\npage.inner_text('body')"}}],usage:{in:1,out:1}};
    const wire=JSON.stringify(toModelMessages(request.messages));
    expect(wire).toContain('browser__python');
    expect(wire).toContain('invocationId');
    expect(wire).not.toContain('Observed but never printed');
    return {toolCalls:[{id:'done',name:'browser.python',args:{source:'browser.done()'}}],usage:{in:1,out:1}};
  }},tools:[tool],task:{prompt:'explore'},trigger:null,emits:[],trace:trace(),contextHistory:f.history});
  expect(result.outcome).toBe('done');
  expect((await f.restore().pending()).filter(e=>e.name==='playwright.call')).toHaveLength(2);
});

it("archives operation exceptions and redacts sensitive read fields",async()=>{
  const f=fixture(), browser=pythonFixture();const tool=browser.tool({contextHistory:f.history});
  browser.calls.mockRejectedValueOnce(new AppError('browser_timeout','uncertain write'));
  await tool.execute({source:"page.click('button')"});
  browser.calls.mockResolvedValueOnce({password:'secret plaintext',text:'visible'});
  await tool.execute({source:"page.evaluate('() => window.data')"});
  const entries=await f.history.pending();
  expect(entries.some(e=>e.name==='playwright.call'&&JSON.stringify(e.result).includes('uncertain write'))).toBe(true);
  expect(JSON.stringify(entries)).not.toContain('secret plaintext');
  expect([...f.data.values()].map(b=>b.toString()).join('')).not.toContain('secret plaintext');
});

it("records imported proxy results once and reports local signature errors",async()=>{
  const f=fixture(), browser=pythonFixture();const tool=browser.tool({contextHistory:f.history});
  const result=await tool.execute({source:"from playwright.sync_api import page\npage.title()\npage.title('invalid argument')"});
  expect(result).toMatchObject({ok:false,error:expect.stringContaining('too many positional')});
  const entries=(await f.history.pending()).filter(e=>e.name==='playwright.call');
  expect(entries).toHaveLength(1);expect(entries[0]!.result).toMatchObject({ok:true,value:'Observed but never printed'});
});

async function populate(f: ReturnType<typeof fixture>, count: number) {
  for (let i = 1; i <= count; i++) await f.history.append({ operationId: `op-${i}`, invocationId: "cell", name: i === 1 ? "record.outcome" : "harness.observe", effect: i === 1,
    args: { id: i }, result: { ok: i !== 2, value: i === 1 ? "saved identity-1" : i === 2 ? "selector failed; pending recovery" : `observation-${i}:` + "a ".repeat(1400) } });
}
it("compacts older SDK results into durable memory and retrieves full evidence after restart", async () => {
  const f = fixture(); await populate(f, 45);
  const requests: LlmRequest[] = [];
  const messages: LlmMessage[] = [{ role: "user", content: "Begin" }];
  const recorder = trace();
  await prepareContext({ history: f.history, messages, llm: { complete: async request => {
    requests.push(structuredClone(request));
    return { text: "Saved identity-1 (operation 1). Selector failed (operation 2); recovery remains pending. Read full evidence with history.read.", toolCalls: [], usage: { in: 1, out: 1 } };
  } }, trace: recorder, system: "explore", tools: [], maxInputTokens: 32000,
  checkpoint: { acknowledged: ["identity-1"] }, memory: { next: "recover selector" }, progress: { requiresReconciliation: true } });
  expect(requests.length).toBeGreaterThan(0);
  expect(requests[0]!.messages[0]!.content).toContain("saved identity-1");
  expect(messages[0]!.contextMemory).toContain("recovery remains pending");
  expect(messages[0]!.contextMemory).toContain("observation-45");
  expect(messages[0]!.contextMemory!.length).toBeLessThan(44000);
  expect(await f.restore().summary()).toContain("operation 1");
  const archived = await f.restore().read({ sequence: 3, offset: 0, limit: 8000 });
  expect(archived).toMatchObject({ text: expect.stringContaining("a ".repeat(1400)), nextOffset: null });
  expect(recorder.record).toHaveBeenCalledWith("runtime", expect.objectContaining({ action: "context.compacted", reason: expect.stringMatching(/^(history_limit|token_budget)$/) }));
});

it("compacts complete older model turns under token pressure and preserves valid tool pairs", async () => {
  const f = fixture();
  const messages: LlmMessage[] = [{ role: "user", content: "Begin" }];
  for (let i = 0; i < 8; i++) messages.push(
    { role: "assistant", content: "call", toolCalls: [{ id: String(i), name: "browser.python", args: { source: "print('" + "large source ".repeat(250) + "')" } }] },
    { role: "tool", content: "result", toolResults: [{ id: String(i), name: "browser.python", result: { ok: true, value: "old observation ".repeat(150) } }] },
  );
  const recorder = trace();
  await prepareContext({ history: f.history, messages, llm: { complete: async () => ({ text: "Earlier calls observed the destination; next step is collection.", toolCalls: [], usage: { in: 1, out: 1 } }) },
    trace: recorder, system: "explore", tools: [], maxInputTokens: 6500, checkpoint: null, memory: null, progress: null });
  expect(estimateModelInput({ system: "explore", tools: [], messages: toModelMessages(messages) }).inputTokenBound).toBeLessThanOrEqual(6500);
  expect(messages.at(-2)?.toolCalls?.[0]?.id).toBe("7");
  expect(messages.at(-1)?.toolResults?.[0]?.id).toBe("7");
  expect(recorder.record).toHaveBeenCalledWith("runtime", expect.objectContaining({ action: "context.compacted", reason: "token_budget" }));
});

it("keeps uncompacted evidence intact if summarization fails", async () => {
  const f = fixture(); await populate(f, 30);
  await expect(prepareContext({ history: f.history, messages: [{ role: "user", content: "Begin" }], llm: { complete: async () => { throw new Error("model unavailable"); } },
    trace: trace(), system: "explore", tools: [], maxInputTokens: 32000, checkpoint: null, memory: null, progress: null })).rejects.toThrow("model unavailable");
  expect(await f.restore().pending()).toHaveLength(30);
  expect(await f.restore().summary()).toBe("");
});

it.each([false, true])("preserves the durable archive while retrying oversized summaries (exhausted=%s)", async (exhausted) => {
  const f = fixture(); await populate(f, 30);
  const messages: LlmMessage[] = [{ role: "user", content: "Begin" }];
  await f.history.saveMessages(messages);
  const original = await f.restore().pending();
  const complete = vi.fn(async () => {
    // No unvalidated summary or dropped operations may become durable during retries.
    if (exhausted || complete.mock.calls.length <= 2) {
      expect(await f.restore().summary()).toBe("");
      expect(await f.restore().pending()).toEqual(original);
      expect(await f.restore().messages()).toEqual([{ role: "user", content: "Begin" }]);
    }
    return { text: exhausted || complete.mock.calls.length === 1 ? "x".repeat(8001)
      : "Saved identity-1 (operation 1); failed selector (operation 2) still needs recovery.", toolCalls: [], usage: { in: 1, out: 1 } };
  });
  const preparation = prepareContext({ history: f.history, messages, llm: { complete }, trace: trace(),
    system: "explore", tools: [], maxInputTokens: 32000, checkpoint: null, memory: null, progress: null });
  if (exhausted) {
    await expect(preparation).rejects.toMatchObject({ code: "context_compaction_failed" });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(await f.restore().pending()).toEqual(original);
    expect(await f.restore().summary()).toBe("");
  } else {
    await preparation;
    expect(complete.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await f.restore().summary()).toContain("Saved identity-1");
    expect(await f.restore().read({ sequence: 1, offset: 0, limit: 8000 }))
      .toMatchObject({ text: expect.stringContaining("saved identity-1") });
  }
});

it("keeps history scoped to one run and supports paging older calls and large results", async () => {
  const f = fixture(); await populate(f, 25);
  const first = await f.history.read({ offset: 0, limit: 100 });
  expect(first).toMatchObject({ nextBefore: 6, operations: expect.any(Array) });
  expect(await f.history.read({ before: 6, offset: 0, limit: 100 })).toMatchObject({ operations: expect.arrayContaining([expect.objectContaining({ sequence: 1 })]) });
  const slice = await f.history.read({ sequence: 3, offset: 0, limit: 100 });
  expect(slice).toMatchObject({ nextOffset: 100 });
  await expect(fixture().history.read({ sequence: 3, offset: 0, limit: 100 })).rejects.toThrow("not in this run");
});

it("searches full archived evidence after compaction, including text outside the preview", async () => {
  const f = fixture();
  await f.history.append({ operationId: "inspect-editor", invocationId: "editor-cell", name: "harness.js", effect: false,
    args: {}, result: { ok: true, value: "sidebar ".repeat(600) + "created-row-42: username remains empty" } });
  await f.history.append({ operationId: "failed-click", invocationId: "editor-cell", name: "harness.click", effect: true,
    args: { selector: "button" }, result: { ok: false, code: "browser_target_not_ready", error: "Actual control is a div" } });
  await f.history.compact("A blank row exists; fill it before creating anything else.", 2, [{ role: "user", content: "Resume" }]);
  const restored = f.restore();
  expect(await restored.pending()).toEqual([]);
  expect(await restored.read({ query: "created-row-42", name: "harness.js", invocationId: "editor-cell", offset: 0, limit: 4000 }))
    .toMatchObject({ operations: [{ sequence: 1, excerpt: expect.stringContaining("username remains empty") }], nextBefore: null });
  expect(await restored.read({ failedOnly: true, offset: 0, limit: 4000 }))
    .toMatchObject({ operations: [{ sequence: 2, code: "browser_target_not_ready", excerpt: "Actual control is a div" }] });
  expect(await restored.read({ query: "created-row-42", invocationId: "different-cell", offset: 0, limit: 4000 }))
    .toMatchObject({ operations: [] });
});

it("collapses identical wrapper evidence without losing archive entries or wrapper-only failures", async () => {
  const f = fixture();
  const base = { invocationId: "cell", sdkCallId: 1, effect: false, args: {}, result: { ok: true, value: { tree: "Editor, empty row" } } };
  await f.history.append({ ...base, operationId: "host", name: "harness.accessibility_tree", layer: "gateway" });
  await f.history.append({ ...base, operationId: "wrapper", name: "accessibility_tree", layer: "python-sdk" });
  await f.history.append({ ...base, sdkCallId: 2, operationId: "bad-wrapper", name: "observe", layer: "python-sdk", result: { ok: false, error: "invalid positional argument" } });
  const raw = await f.history.pending();
  expect(contextOperations(raw).map(e => e.sequence)).toEqual([1, 3]);
  expect(await f.restore().read({ sequence: 2, offset: 0, limit: 4000 })).toMatchObject({ text: expect.stringContaining('"operationId":"wrapper"') });
  // Similar truncated previews must not hide a helper's transformed result.
  await f.history.append({ ...base, sdkCallId: 3, operationId: "large-host", name: "harness.js", layer: "gateway",
    result: { ok: true, value: "x".repeat(4000) + "A" } });
  await f.history.append({ ...base, sdkCallId: 3, operationId: "large-wrapper", name: "js", layer: "python-sdk",
    result: { ok: true, value: "x".repeat(4000) + "B" } });
  expect(contextOperations(await f.history.pending()).map(e => e.sequence)).toEqual([1, 3, 4, 5]);
});

it("compacts several old turns together and leaves budget for the next action", async () => {
  const f = fixture();
  const messages: LlmMessage[] = [{ role: "user", content: "Begin" }];
  for (let i = 0; i < 10; i++) messages.push(
    { role: "assistant", content: "", text: i === 0 ? "Created row-42; do not create a duplicate." : undefined,
      toolCalls: [{ id: String(i), name: "browser.python", args: { source: "print('focused observation')" } }] },
    { role: "tool", content: "", toolResults: [{ id: String(i), name: "browser.python", result: { ok: true, value: "editor observation ".repeat(150) } }] },
  );
  const summarize = vi.fn(async (request: LlmRequest) => {
    expect(request.messages[0]!.content).toMatch(/Created row-42|Row-42 exists/);
    return { text: "Row-42 exists; username remains empty. Use editor_helpers.py to fill it.", toolCalls: [], usage: { in: 1, out: 1 } };
  });
  await prepareContext({ history: f.history, messages, llm: { complete: summarize }, trace: trace(), system: "Save the record", tools: [], maxInputTokens: 3200,
    checkpoint: { rowId: "row-42" }, memory: { facts: ["Use editor_helpers.py"], pending: ["Fill username"] }, progress: null });
  expect(summarize.mock.calls.length).toBeGreaterThan(0);
  expect(summarize.mock.calls.length).toBeLessThan(5);
  expect(messages.at(-2)?.toolCalls?.[0]?.id).toBe("9");
  expect(messages.at(-1)?.toolResults?.[0]?.id).toBe("9");
  expect(messages[0]!.contextMemory).toContain("Row-42");
  expect(messages[0]!.contextMemory).not.toContain("Current durable checkpoint");
  expect(messages[0]!.contextMemory).not.toContain("Current operation journal");
  expect(estimateModelInput({ system: "Save the record", tools: [], messages: toModelMessages(messages) }).inputTokenBound).toBeLessThan(3200 * 0.8);
});

it("retains the latest complete turn when only the soft character target is exceeded", async () => {
  const f = fixture();
  const llm = { complete: vi.fn() };
  const messages: LlmMessage[] = [{ role: "user", content: "Begin" }, { role: "assistant", content: "look" }, { role: "tool", content: "observation ".repeat(6000), toolResults: [] }];
  await prepareContext({ history: f.history, messages, llm, trace: trace(), system: "explore", tools: [], maxInputTokens: 32000,
    checkpoint: null, memory: null, progress: null });
  expect(messages).toHaveLength(3);
  expect(llm.complete).not.toHaveBeenCalled();
});

it("restores the prior tool call/result transcript after an interrupted model loop without repeating effects", async () => {
  const f = fixture();
  const browser=pythonFixture();const mutate=browser.calls;
  mutate.mockResolvedValue({saved:'record-7'});
  let turns = 0;
  await expect(runAgentLoop({ task: { prompt: "save" }, trigger: null, emits: [], trace: trace(), contextHistory: f.history,
    tools: [browser.tool({contextHistory:f.history})],
    llm: { complete: async () => {
      if (turns++) throw new Error("model disconnected");
      return { toolCalls: [{ id: "write", name: "browser.python", args: { source: "page.click('button')" } }], usage: { in: 1, out: 1 } };
    } },
  })).rejects.toThrow("model disconnected");
  const restored = f.restore();
  expect(await runAgentLoop({ task: { prompt: "save" }, trigger: null, emits: [], trace: trace(), contextHistory: restored,
    tools: [browser.tool({contextHistory:restored})],
    llm: { complete: async request => {
      const wire = JSON.stringify(toModelMessages(request.messages));
      expect(wire).toContain("page.click('button')");
      expect(wire).not.toContain("record-7");
      return { toolCalls: [{ id: "finish", name: "browser.python", args: { source: "browser.done()" } }], usage: { in: 1, out: 1 } };
    } },
  })).toMatchObject({ outcome: "done" });
  expect(mutate).toHaveBeenCalledOnce();
});
