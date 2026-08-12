import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Llm, LlmRequest, LlmResponse, ToolDef } from "./llm.js";
import { recordLlm, replayLlm } from "./transcript.js";

/**
 * Pure-function coverage for `record`/`replay` — no SDK, no network, exactly the interface
 * `llm.ts` exposes. A stubbed inner `Llm` stands in for the live transport.
 */

let dir: string;
let fixturePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabductor-llm-transcript-"));
  fixturePath = join(dir, "transcript.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TOOL: ToolDef = { name: "page.click", description: "click an anchor", parameters: z.object({ anchor: z.string() }) };

function stubLlm(...responses: LlmResponse[]): Llm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  let i = 0;
  return {
    calls,
    complete(req) {
      calls.push(req);
      const res = responses[Math.min(i++, responses.length - 1)]!;
      return Promise.resolve(res);
    },
  };
}

const REQUEST: LlmRequest = {
  system: "You browse a page.",
  messages: [{ role: "user", content: "go" }],
  tools: [TOOL],
};

const RESPONSE: LlmResponse = {
  text: "done",
  toolCalls: [{ id: "call_1", name: "page.click", args: { anchor: "e1" } }],
  usage: { in: 10, out: 5 },
};

describe("recordLlm -> replayLlm round trip", () => {
  it("replays exactly what was recorded, given a matching request shape", async () => {
    const inner = stubLlm(RESPONSE);
    const recorded = await recordLlm(inner, fixturePath).complete(REQUEST);
    expect(recorded).toEqual(RESPONSE);
    expect(inner.calls).toEqual([REQUEST]);

    const replayed = await replayLlm(fixturePath).complete(REQUEST);
    expect(replayed).toEqual(RESPONSE);
  });

  it("records multiple turns as separate JSONL lines and replays them in order", async () => {
    const second: LlmResponse = { toolCalls: [], usage: { in: 3, out: 1 } };
    const inner = stubLlm(RESPONSE, second);
    const recorder = recordLlm(inner, fixturePath);
    await recorder.complete(REQUEST);
    await recorder.complete({ ...REQUEST, messages: [...REQUEST.messages, { role: "assistant", content: "ok" }] });

    const replayer = replayLlm(fixturePath);
    await expect(replayer.complete(REQUEST)).resolves.toEqual(RESPONSE);
    await expect(
      replayer.complete({ ...REQUEST, messages: [...REQUEST.messages, { role: "assistant", content: "ok" }] }),
    ).resolves.toEqual(second);
  });
});

describe("replayLlm divergence", () => {
  it("throws a descriptive error when the requested tool set differs", async () => {
    const inner = stubLlm(RESPONSE);
    await recordLlm(inner, fixturePath).complete(REQUEST);

    const otherTool: ToolDef = { name: "page.goto", description: "navigate", parameters: z.object({ url: z.string() }) };
    await expect(
      replayLlm(fixturePath).complete({ ...REQUEST, tools: [otherTool] }),
    ).rejects.toThrow(/tool set/);
  });

  it("throws a descriptive error when the message count differs", async () => {
    const inner = stubLlm(RESPONSE);
    await recordLlm(inner, fixturePath).complete(REQUEST);

    await expect(
      replayLlm(fixturePath).complete({
        ...REQUEST,
        messages: [...REQUEST.messages, { role: "assistant", content: "extra" }],
      }),
    ).rejects.toThrow(/message/);
  });

  it("throws a descriptive error, naming the index, when the transcript is exhausted", async () => {
    const inner = stubLlm(RESPONSE);
    await recordLlm(inner, fixturePath).complete(REQUEST);

    const replayer = replayLlm(fixturePath);
    await replayer.complete(REQUEST);
    await expect(replayer.complete(REQUEST)).rejects.toThrow(/1 recorded turn/);
  });

  it("rejects a transcript file that fails zod validation on load", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(fixturePath, `${JSON.stringify({ request: {}, response: {} })}\n`);
    expect(() => replayLlm(fixturePath)).toThrow();
  });
});
