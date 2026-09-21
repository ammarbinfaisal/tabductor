import { describe, expect, it } from "vitest";
import { parseGeneratedJson } from "./generated-json.js";

describe("parseGeneratedJson", () => {
  it("recovers nested trailing commas in fenced model output", () => {
    expect(parseGeneratedJson('```json\n{"tasks": [{"name": "Read",},], "store": null,}\n```'))
      .toEqual({ tasks: [{ name: "Read" }], store: null });
  });

  it("preserves prompt text, escaped quotes, backslashes and Unicode during recovery", () => {
    const prompt = 'Keep ,} and ,] literally. Say "hello". Path C:\\work\\ and हिन्दी.';
    const source = JSON.stringify({ prompt, nested: { value: 1 } });
    expect(parseGeneratedJson(source.slice(0, -1) + ",}"))
      .toEqual({ prompt, nested: { value: 1 } });
  });

  it("preserves valid JSON unchanged", () => {
    const value = { text: "```json ,] ,}", null: null, bool: false, array: [0, -1, 1.5] };
    expect(parseGeneratedJson(JSON.stringify(value))).toEqual(value);
  });

  it.each(['{"a":', '{"a": 1,,}', '[1,,]', '[,]', '{,}', '{unquoted: 1}', '{"a": "unfinished}', 'Here is JSON: {"a":1}'])
    ("rejects ambiguous or incomplete output: %s", source => {
      expect(() => parseGeneratedJson(source)).toThrow(SyntaxError);
    });

  it("reports the original error position when formatting repair is insufficient", () => {
    const source = '{"a": [1,], bad: 2}';
    let original: unknown;
    try { JSON.parse(source); } catch (error) { original = error; }
    expect(() => parseGeneratedJson(source)).toThrow((original as Error).message);
  });
});
