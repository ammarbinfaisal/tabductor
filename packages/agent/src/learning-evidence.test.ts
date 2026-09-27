import { expect, it } from "vitest";
import { renderLearnedPrompt } from "@tabductor/core";
import { groundLearningResult, learningEvidence, type BrowserLearningResult } from "./learning-evidence.js";
import { runAgentLoop } from "./loop.js";
import { doneTool } from "./tools.js";

const evidence = learningEvidence({ runId: "r", entries: [
  { seq: 1, kind: "action", payload: { action: "sdk.operation", phase: "finished", result: { ok: false, error: "missing locator" } } },
  { seq: 2, kind: "action", payload: { action: "sdk.operation", phase: "finished", result: { ok: true, value: "opened editor" } } },
] });
const result = (): BrowserLearningResult => ({ procedure: {
  steps: [{ instruction: "Open the editor for browser.input.id", evidence: ["r:2"] }],
  cautions: [{ instruction: "Inspect the editor before selecting a locator", evidence: ["r:1"] }], instructions: "Verify the saved record.",
}, deopt: null, compile: { eligible: true, reason: "A short successful procedure", evidence: ["r:2"] } });

it("accepts failed evidence as cautions, but never as a successful procedure", () => {
  expect(evidence.failedOperations).toBe(1);
  expect(groundLearningResult(result(), { evidence, succeeded: true, hasDeopt: false }).compile.eligible).toBe(true);
  const invalid = result(); invalid.procedure!.steps[0]!.evidence = ["r:1"];
  expect(() => groundLearningResult(invalid, { evidence, succeeded: true, hasDeopt: false })).toThrow("successful observed evidence");
});

it("failed runs preserve proven instructions and cannot authorize compilation", () => {
  const previous = { steps: [{ instruction: "Existing proven procedure", evidence: ["old:1"] }], cautions: [], instructions: "Existing operating instructions" };
  const learned = groundLearningResult(result(), { evidence, previous, succeeded: false, hasDeopt: false });
  expect(learned.procedure).toMatchObject({ steps: previous.steps, instructions: previous.instructions });
  expect(learned.procedure!.cautions).toHaveLength(1);
  expect(learned.compile.eligible).toBe(false);
});

it("rejects invented provenance and deopt updates with no supplied scope", () => {
  const invalid = result(); invalid.procedure!.steps[0]!.evidence = ["invented"];
  expect(() => groundLearningResult(invalid, { evidence, succeeded: true, hasDeopt: false })).toThrow("not given");
  const deopt = result(); deopt.deopt = { prompt: "Resume after the write", evidence: ["r:2"] };
  expect(() => groundLearningResult(deopt, { evidence, succeeded: true, hasDeopt: false })).toThrow("scope");
});

it("bounds trace payload previews and keeps failures visible", () => {
  const e = learningEvidence({ runId: "r", entries: [{ seq: 1, kind: "action", payload: {
    action: "sdk.operation", phase: "finished", result: { ok: false, outcomeUncertain: true, value: "x".repeat(20000) },
  } }] });
  expect(e.entries[0]).toMatchObject({ ok: false, truncated: true });
  expect(e.entries[0]!.evidence.length).toBe(4000);
  expect(e.uncertainEffects).toBe(1);
});

it("keeps the initial learned block when conversation history is compacted", async () => {
  const prompt = renderLearnedPrompt("Complete the current task.", result().procedure!);
  let turns = 0, compacted = false, previousMessages = 0;
  const observe = { ...doneTool(), name: "observe", execute: async () => ({ ok: true as const, value: "Observed value. ".repeat(800) }) };
  await runAgentLoop({ task: { prompt }, trigger: null, emits: [], maxInputTokens: 7000,
    trace: { record: async () => {}, flush: async () => {}, close: async () => {} }, tools: [observe, doneTool()],
    llm: { complete: async request => {
      if (request.system.startsWith("Compress the agent")) return { text: "Observed historical values.", toolCalls: [], usage: { in: 1, out: 1 } };
      expect(request.system.startsWith(prompt)).toBe(true);
      if (previousMessages && request.messages.length <= previousMessages) compacted = true;
      previousMessages = request.messages.length;
      return { toolCalls: [{ id: String(++turns), name: turns === 12 ? "done" : "observe", args: {} }], usage: { in: 1, out: 1 } };
    } } });
  expect(compacted).toBe(true);
});
