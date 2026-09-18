import { describe, expect, it } from "vitest";
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
      task: { prompt: "Store one incoming tweet." },
      trigger: null,
      emits: [],
      trace,
    });

    expect(result.outcome).toBe("done");
    expect(request?.system).toContain("independently scheduled event-driven run");
    expect(request?.system).toContain("does not call or wait for consumers");
    expect(request?.system).toContain("Emit each complete independent record immediately");
    expect(request?.system).toContain("Never poll for downstream completion");
  });
});
