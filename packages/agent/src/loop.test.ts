import { describe, expect, it, vi } from "vitest";
import { ASYNC_EVENT_EXECUTION_CONTRACT, AUTHENTICATION_EXECUTION_CONTRACT } from "@tabductor/engine";
import { z } from "zod";
import { runAgentLoop, type RunAgentLoopOptions } from "./loop.js";
import type { LlmRequest } from "./llm.js";
import { buildToolRegistry, summarizePerception } from "./tools.js";
import type { RunSession } from "@tabductor/browser";

const trace = { record: vi.fn(async () => undefined), flush: async () => undefined, close: async () => undefined };

it("supplies corrected authentication guidance even for previously published browser prompts", async () => {
  let request: LlmRequest | undefined;
  await runAgentLoop({ llm: { complete: async input => {
    request = input;
    return { toolCalls: [{ id: "done", name: "done", args: {} }], usage: { in: 1, out: 1 } };
  } }, tools: [
    { name: "page.perceive", description: "observe", parameters: z.object({}), execute: async () => ({ ok: true, value: null }) },
    { name: "done", description: "finish", parameters: z.object({}), execute: async () => ({ ok: true, value: null }) },
  ], task: { prompt: "Ensure Login with Google into notion. If sign-in is needed, request takeover." }, trigger: null, emits: [], trace });
  expect(request!.system).toContain(AUTHENTICATION_EXECUTION_CONTRACT);
  expect(request!.system).toContain("Attempt the authorized browser flow first");
});

it("makes no model calls during takeover and discards actions planned before resume", async () => {
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  let checks = 0;
  const cancel = new AbortController();
  const click = vi.fn(async () => ({ ok: true as const, value: null }));
  const model = vi.fn(async () => ({ toolCalls: [{ id: "old", name: "page.click", args: {} }], usage: { in: 1, out: 1 } }));
  const run = runAgentLoop({ llm: { complete: model }, tools: [{ name: "page.click", description: "click", parameters: z.object({}), execute: click }],
    task: { prompt: "act" }, trigger: null, emits: [], trace, signal: cancel.signal,
    beforeStep: async () => { if (++checks === 1) { await paused; return undefined; } cancel.abort(); return { url: "fresh" }; } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(model).not.toHaveBeenCalled();
  resume(); expect(await run).toEqual({ outcome: "fail", reason: "run_cancelled" });
  expect(model).toHaveBeenCalledTimes(1);
  expect(click).not.toHaveBeenCalled();
});

it("bounds model history and preserves the durable checkpoint across long collection loops", async () => {
  const lengths: number[] = [];
  const checkpoints: boolean[] = [];
  const result = await runAgentLoop({ llm: { complete: async (request) => {
    lengths.push(request.messages.reduce((n, message) => n + message.content.length, 0));
    checkpoints.push(request.messages.some((message) => message.content.includes('"emitted":75')));
    return { toolCalls: [{ id: String(lengths.length), name: lengths.length === 100 ? "done" : "observe", args: {} }], usage: { in: 1, out: 1 } };
  } }, tools: [{ name: "observe", description: "read", parameters: z.object({}), execute: async () => ({ ok: true, value: "x".repeat(18000) }) },
    { name: "done", description: "finish", parameters: z.object({}), execute: async () => ({ ok: true, value: "collected" }) }],
    task: { prompt: "collect" }, trigger: null, emits: [], trace, checkpoint: { get: async () => ({ emitted: 75 }) } });
  expect(result).toEqual({ outcome: "done", result: "collected" });
  expect(lengths).toHaveLength(100);
  expect(Math.max(...lengths)).toBeLessThan(80_000);
  expect(checkpoints.some(Boolean)).toBe(true);
});

it("honors cancellation after more than 30 turns even when the model never calls a tool", async () => {
  const cancel = new AbortController();
  let turns = 0;
  const result = await runAgentLoop({ llm: { async complete(request) {
    expect(request.signal).toBe(cancel.signal);
    if (++turns === 40) cancel.abort();
    return { toolCalls: [], text: "Still working", usage: { in: 1, out: 1 } };
  } }, tools: [], task: { prompt: "work" }, trigger: null, emits: [], trace, signal: cancel.signal });
  expect(turns).toBe(40);
  expect(result).toEqual({ outcome: "fail", reason: "run_cancelled" });
});

it("allows failure after bounded recovery even if the same wait keeps failing", async () => {
  const session = { page: { waitFor: async () => { throw new Error("not found"); }, perceive: async () => ({ url: "https://fixture.test", text: "", title: "", elements: [] }) },
    resolveAnchor: () => "article" } as unknown as RunSession;
  const tools = new Map(buildToolRegistry({ session, emit: async () => ({ outcome: "deduped" }) }).map((tool) => [tool.name, tool]));
  await tools.get("page.waitFor")!.execute({ anchor: "e1" });
  expect(await tools.get("fail")!.execute({ reason: "blocked" })).toMatchObject({ ok: false });
  await tools.get("page.waitFor")!.execute({ anchor: "e1" });
  await tools.get("page.waitFor")!.execute({ anchor: "e1" });
  expect(await tools.get("fail")!.execute({ reason: "blocked after recovery" })).toMatchObject({ ok: true });
});

it("does not execute later side effects after a terminal call", async () => {
  const sideEffect = vi.fn();
  const result = await runAgentLoop({ llm: { complete: async () => ({ toolCalls: [{ id: "done", name: "done", args: {} }, { id: "write", name: "write", args: {} }], usage: { in: 1, out: 1 } }) },
    tools: [{ name: "done", description: "done", parameters: z.object({}), execute: async () => ({ ok: true, value: null }) },
      { name: "write", description: "write", parameters: z.object({}), execute: sideEffect }],
    task: { prompt: "finish" }, trigger: null, emits: [], trace });
  expect(result.outcome).toBe("done");
  expect(sideEffect).not.toHaveBeenCalled();
});

it("discards the rest of a model tool list after a page error refreshes anchors", async () => {
  const staleClick = vi.fn();
  let turns = 0;
  await runAgentLoop({ llm: { complete: async () => ({ toolCalls: turns++ === 0
    ? [{ id: "read", name: "page.extract", args: {} }, { id: "click", name: "page.click", args: {} }]
    : [{ id: "end", name: "fail", args: {} }], usage: { in: 1, out: 1 } }) },
    tools: [{ name: "page.extract", description: "extract", parameters: z.object({}), execute: async () => ({ ok: false, error: "invalid selector; new perception attached" }) },
      { name: "page.click", description: "click", parameters: z.object({}), execute: staleClick },
      { name: "fail", description: "finish", parameters: z.object({}), execute: async () => ({ ok: true, value: "test complete" }) }],
    task: { prompt: "read" }, trigger: null, emits: [], trace });
  expect(staleClick).not.toHaveBeenCalled();
});

it("keeps later anchors accessible when perception is paged", () => {
  const elements = Array.from({ length: 150 }, (_, i) => ({ anchor: `e${i}`, tag: "button", role: "button", name: "control", text: "label", strategy: "testid" as const, locator: `#b${i}` }));
  const page = { url: "https://fixture.test", title: "", text: "", elements };
  expect(summarizePerception(page)).toMatchObject({ nextElementOffset: 100, totalElements: 150 });
  expect(summarizePerception(page, 100)).toMatchObject({ nextElementOffset: null, elements: expect.arrayContaining([expect.objectContaining({ anchor: "e149" })]) });
});

describe("runAgentLoop system contract", () => {
  it("enforces asynchronous per-record event handoff for every node kind", async () => {
    let request: LlmRequest | undefined;
    const trace: RunAgentLoopOptions["trace"] = {
      record: async () => undefined,
      flush: async () => undefined,
      close: async () => undefined,
    };
    const result = await runAgentLoop({
      llm: {
        async complete(input) {
          request = input;
          return {
            toolCalls: [{ id: "done-1", name: "done", args: {} }],
            usage: { in: 1, out: 1 },
          };
        },
      },
      tools: [{
        name: "done",
        description: "finish",
        parameters: z.object({}),
        execute: async () => ({ ok: true as const, value: null }),
      }],
      task: { prompt: "Store one incoming record." },
      trigger: null,
      emits: [],
      trace,
    });

    expect(result.outcome).toBe("done");
    expect(request?.system).toContain(ASYNC_EVENT_EXECUTION_CONTRACT);
    expect(request?.system).toContain("returns without waiting for any consumer");
    expect(request?.system).toContain("emit each complete item immediately");
    expect(request?.system).toContain("A consumes list is not a join");
  });
});
