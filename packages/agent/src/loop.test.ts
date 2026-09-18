import { describe, expect, it } from "vitest";
import { ASYNC_EVENT_EXECUTION_CONTRACT } from "@tabductor/engine";
import { z } from "zod";
import { runAgentLoop, type RunAgentLoopOptions } from "./loop.js";
import type { LlmRequest } from "./llm.js";

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
