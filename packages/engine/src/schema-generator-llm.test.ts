import { describe, expect, it } from "vitest";
import type { SchemaGenInput } from "./schema-generator.js";
import { llmSchemaGenerator, parseSchema, type ChatTransport, type ChatTurn } from "./schema-generator-llm.js";

/**
 * The compiler's behaviour, with the network replaced by a scripted transport. This is the
 * half that is identical for every provider, so it is tested once here rather than twice
 * against two SDKs.
 */

const INPUT: SchemaGenInput = {
  eventType: "tweet.detected",
  description: "A tweet found on the timeline: its text and author handle.",
  emitters: [{ name: "Watcher", prompt: "Open the timeline and emit each new tweet." }],
  consumers: [{ name: "Ranker", prompt: null }],
};

const GOOD = JSON.stringify({
  type: "object",
  properties: { text: { type: "string" }, author: { type: "string" } },
  required: ["text", "author"],
  additionalProperties: false,
});

/** Replays scripted replies and records what it was asked, so the loop's own inputs are assertable. */
function scripted(...replies: Array<string | Error | { refused: true }>): ChatTransport & {
  calls: ChatTurn[][];
} {
  const calls: ChatTurn[][] = [];
  let i = 0;
  return {
    calls,
    complete(turns) {
      calls.push(turns.map((t) => ({ ...t })));
      const reply = replies[Math.min(i++, replies.length - 1)];
      if (reply instanceof Error) return Promise.reject(reply);
      if (typeof reply !== "string") return Promise.resolve(reply);
      return Promise.resolve({ text: reply });
    },
  };
}

describe("llmSchemaGenerator", () => {
  it("passes the event, its description and both sides' prompts to the model", async () => {
    const transport = scripted(GOOD);
    const result = await llmSchemaGenerator(transport).generate(INPUT);

    expect(result).toEqual({ ok: true, schema: JSON.parse(GOOD) });
    const [prompt] = transport.calls[0]!;
    expect(prompt!.content).toContain("tweet.detected");
    expect(prompt!.content).toContain("its text and author handle");
    expect(prompt!.content).toContain("Open the timeline");
    // A consumer without a prompt is still named: which tasks read the event is context.
    expect(prompt!.content).toContain("Ranker");
  });

  it("accepts a fenced reply rather than spending an attempt on formatting", async () => {
    const transport = scripted("```json\n" + GOOD + "\n```");
    await expect(llmSchemaGenerator(transport).generate(INPUT)).resolves.toEqual({
      ok: true,
      schema: JSON.parse(GOOD),
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("feeds the gate's verdict back and accepts the repair", async () => {
    // `format: "not-a-format"` is exactly what strict mode is there to catch.
    const rejected = JSON.stringify({
      type: "object",
      properties: { text: { type: "string", format: "not-a-format" } },
      required: ["text"],
      additionalProperties: false,
    });
    const transport = scripted(rejected, GOOD);

    const result = await llmSchemaGenerator(transport).generate(INPUT);

    expect(result).toEqual({ ok: true, schema: JSON.parse(GOOD) });
    expect(transport.calls).toHaveLength(2);
    const second = transport.calls[1]!;
    // The model sees its own output and the verdict verbatim — a bare "try again" would
    // leave it guessing at what strict mode objected to.
    expect(second[1]).toEqual({ role: "assistant", content: rejected });
    expect(second[2]!.content).toContain("was rejected");
    expect(second[2]!.content).toContain("ajv strict");
  });

  it("gives up after three attempts and reports the last rejection", async () => {
    const transport = scripted("not json at all");
    const result = await llmSchemaGenerator(transport).generate(INPUT);

    expect(transport.calls).toHaveLength(3);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("not valid JSON");
  });

  it("reports an API failure without burning repair attempts on it", async () => {
    // A 401 does not become a 200 by being asked three times, and the operator needs the
    // provider's own words in the compile report to know what to fix.
    const transport = scripted(new Error("401 Incorrect API key provided"));
    const result = await llmSchemaGenerator(transport).generate(INPUT);

    expect(transport.calls).toHaveLength(1);
    expect(result).toEqual({ ok: false, error: "401 Incorrect API key provided" });
  });

  it("treats a refusal as final", async () => {
    const transport = scripted({ refused: true });
    const result = await llmSchemaGenerator(transport).generate(INPUT);

    expect(transport.calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("declined by the model");
  });

  it("never throws, whatever the transport does", async () => {
    const transport: ChatTransport = {
      complete: () => Promise.reject("a string, not an Error"),
    };
    await expect(llmSchemaGenerator(transport).generate(INPUT)).resolves.toEqual({
      ok: false,
      error: "a string, not an Error",
    });
  });
});

describe("parseSchema", () => {
  it("rejects a JSON array, which is valid JSON but not a schema object", () => {
    const parsed = parseSchema("[1, 2, 3]");
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain("not a JSON object");
  });
});
