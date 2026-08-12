import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceRecorder } from "@tabductor/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLlm } from "./llm.js";
import { recordLlm } from "./transcript.js";
import type { Llm, LlmRequest, LlmResponse } from "./llm.js";

let dir: string;
let fixturePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabductor-llm-factory-"));
  fixturePath = join(dir, "transcript.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const REQUEST: LlmRequest = { system: "s", messages: [{ role: "user", content: "hi" }], tools: [] };
const RESPONSE: LlmResponse = { text: "ok", toolCalls: [], usage: { in: 1, out: 1 } };

describe("createLlm", () => {
  it("throws a config error for live/record without provider+apiKey", () => {
    expect(() => createLlm("live", {})).toThrow(/provider/);
    expect(() => createLlm("record", { provider: "openai", apiKey: "x" })).toThrow(/fixturePath/);
  });

  it("throws a config error for replay without a fixturePath", () => {
    expect(() => createLlm("replay", {})).toThrow(/fixturePath/);
  });

  it("wires replay mode to a working Llm", async () => {
    const inner: Llm = { complete: () => Promise.resolve(RESPONSE) };
    await recordLlm(inner, fixturePath).complete(REQUEST);

    const llm = createLlm("replay", { fixturePath });
    await expect(llm.complete(REQUEST)).resolves.toEqual(RESPONSE);
  });

  it("records a trace entry per call with a hash, usage and tool-call names — never prompt or completion text", async () => {
    const inner: Llm = { complete: () => Promise.resolve(RESPONSE) };
    await recordLlm(inner, fixturePath).complete(REQUEST);

    const recorded: { kind: string; payload: Record<string, unknown> }[] = [];
    const trace: TraceRecorder = {
      record: (kind, payload) => {
        recorded.push({ kind, payload });
        return Promise.resolve();
      },
      flush: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    const llm = createLlm("replay", { fixturePath, trace });
    await llm.complete(REQUEST);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe("llm");
    expect(recorded[0]!.payload).toMatchObject({ usage: RESPONSE.usage, tool_calls: [] });
    expect(typeof recorded[0]!.payload.prompt_hash).toBe("string");
    expect(JSON.stringify(recorded)).not.toContain("hi");
    expect(JSON.stringify(recorded)).not.toContain("ok");
  });
});
