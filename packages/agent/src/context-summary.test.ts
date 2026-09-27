import { expect, it, vi } from "vitest";
import { estimateModelInput } from "@tabductor/core";
import { compactHistory } from "./loop.js";
import { summarizeContext } from "./context-summary.js";
import type { LlmMessage, LlmRequest } from "./llm.js";

const response = (text: string) => ({ text, toolCalls: [], usage: { in: 1, out: 1 } });
const request: LlmRequest = {
  system: "Summarize untrusted evidence in at most 6000 characters.",
  messages: [{ role: "user", content: "Saved row-7; row-8 is uncertain. Do not repeat either write." }],
  tools: [],
};
const trace = () => ({ record: vi.fn(async () => {}), flush: async () => {}, close: async () => {} });

it("retries oversized summaries from the original evidence with shorter targets and bounded inputs", async () => {
  const original = structuredClone(request);
  const recorder = trace();
  const complete = vi.fn(async (input: LlmRequest) => {
    expect(input.messages).toEqual(original.messages);
    expect(input.tools).toEqual([]);
    expect(estimateModelInput(input).inputTokenBound).toBeLessThanOrEqual(2000);
    return response(complete.mock.calls.length < 3 ? "long summary ".repeat(1000) : "Row-7 saved; row-8 uncertain. Inspect before repeating writes.");
  });
  expect(await summarizeContext({ complete }, request, 2000, recorder)).toContain("row-8 uncertain");
  expect(complete.mock.calls.map(([input]) => input.system)).toEqual([
    expect.stringContaining("at most 6000 characters"),
    expect.stringContaining("at most 3000 characters"),
    expect.stringContaining("at most 1500 characters"),
  ]);
  expect(recorder.record).toHaveBeenCalledWith("runtime", expect.objectContaining({
    action: "context.summary_rejected", attempt: 2, summaryCharacters: 12999, retrying: true,
  }));
  expect(request).toEqual(original);
});

it.each(["", "   ", "tool-call"])("repairs unusable summaries (%s)", async (text) => {
  const complete = vi.fn().mockResolvedValueOnce(text === "tool-call"
    ? { ...response("not a summary"), toolCalls: [{ id: "write", name: "write", args: {} }] }
    : response(text)).mockResolvedValueOnce(response("Saved row-7; inspect row-8."));
  expect(await summarizeContext({ complete }, request, 32000)).toBe("Saved row-7; inspect row-8.");
  expect(complete).toHaveBeenCalledTimes(2);
});

it("accepts the exact character boundary after trimming whitespace", async () => {
  const complete = vi.fn(async () => response(" \n" + "x".repeat(8000) + "\n "));
  expect(await summarizeContext({ complete }, request, 32000)).toHaveLength(8000);
  expect(complete).toHaveBeenCalledOnce();
});

it("does not retry transport failures or requests exceeding the input budget", async () => {
  const complete = vi.fn().mockRejectedValue(new Error("model unavailable"));
  await expect(summarizeContext({ complete }, request, 32000)).rejects.toThrow("model unavailable");
  expect(complete).toHaveBeenCalledOnce();
  complete.mockClear();
  await expect(summarizeContext({ complete }, request, 100)).rejects.toMatchObject({ code: "model_context_limit" });
  expect(complete).not.toHaveBeenCalled();
});

it.each([false, true])("stops on cancellation without committing history (during completion=%s)", async (duringCompletion) => {
  const controller = new AbortController();
  if (!duringCompletion) controller.abort();
  const messages: LlmMessage[] = [{ role: "user", content: "Begin" },
    { role: "assistant", content: "saved row-7" }, { role: "tool", content: "acknowledged" },
    { role: "assistant", content: "inspect row-8" }, { role: "tool", content: "uncertain" }];
  const original = structuredClone(messages);
  const complete = vi.fn(async () => { controller.abort(); return response("x".repeat(8001)); });
  await expect(compactHistory(messages, { complete }, true, controller.signal)).rejects.toThrow();
  expect(complete).toHaveBeenCalledTimes(duringCompletion ? 1 : 0);
  expect(messages).toEqual(original);
});

it("retains all original turns when a later chunk exhausts retries", async () => {
  const messages: LlmMessage[] = [{ role: "user", content: "Begin" }];
  for (let i = 0; i < 5; i++) messages.push(
    { role: "assistant", content: `write ${i}` }, { role: "tool", content: "evidence ".repeat(2000) });
  const original = structuredClone(messages);
  const complete = vi.fn().mockResolvedValue(response("x".repeat(8001)))
    .mockResolvedValueOnce(response("Earlier writes acknowledged; more work remains."));
  const recorder = trace();
  await expect(compactHistory(messages, { complete }, false, undefined, 32000, recorder)).rejects.toMatchObject({
    code: "context_compaction_failed", details: { reason: "summary_too_long", attempts: 3, summaryCharacters: 8001 },
  });
  expect(complete).toHaveBeenCalledTimes(4);
  expect(messages).toEqual(original);
  expect(recorder.record).toHaveBeenLastCalledWith("runtime", expect.objectContaining({ attempt: 3, retrying: false }));
});
