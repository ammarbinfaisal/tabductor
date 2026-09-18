import { afterEach, expect, it, vi } from "vitest";
import { liveLlm } from "./llm-live.js";
import { runAgentLoop } from "./loop.js";

afterEach(() => vi.unstubAllGlobals());

it("propagates run cancellation through the agent loop into the provider HTTP request", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  let transportAborted = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    signal.addEventListener("abort", () => { transportAborted = true; reject(signal.reason); }, { once: true });
    started();
  })));
  const running = runAgentLoop({
    llm: liveLlm({ provider: "openai", model: "fixture-model", apiKey: "fixture-key" }),
    tools: [], task: { prompt: "fixture" }, trigger: null, emits: [], signal: controller.signal,
    trace: { record: async () => undefined, flush: async () => undefined, close: async () => undefined },
  });
  await sending;
  controller.abort();
  await expect(running).rejects.toThrow();
  expect(transportAborted).toBe(true);
});
