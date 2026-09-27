import { describe, expect, it } from "vitest";
import { checkGraph, graphSchema } from "./testing/graph.js";
import { compileResultSchema, parseWorkflowResult } from "./result-schema.js";

describe("workflow result schemas", () => {
  it("validates draft-07 references, constraints and formats without coercion", () => {
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object",
      definitions: { count: { type: "integer", minimum: 1 } },
      properties: { count: { $ref: "#/definitions/count" }, url: { type: "string", format: "uri" } },
      required: ["count"], additionalProperties: false };
    expect(parseWorkflowResult('```json\n{"count":2}\n```', schema)).toEqual({ count: 2 });
    for (const value of [{ count: "2" }, { count: 0 }, {}, { count: 2, extra: 1 }, { count: 2, url: "bad" }]) {
      expect(() => parseWorkflowResult(JSON.stringify(value), schema)).toThrow("result_schema_invalid");
    }
    expect(() => compileResultSchema({ type: "not-a-type" })).toThrow();
  });

  it("allows arbitrary JSON without a schema and supports boolean schemas", () => {
    for (const value of [null, false, 0, "text", [1, 2], { data: [] }]) {
      expect(parseWorkflowResult(JSON.stringify(value))).toEqual(value);
      expect(parseWorkflowResult(JSON.stringify(value), true)).toEqual(value);
      expect(() => parseWorkflowResult(JSON.stringify(value), false)).toThrow("result_schema_invalid");
    }
    expect(() => parseWorkflowResult("not JSON")).toThrow();
  });

  it("requires a single unwired terminal node with a prompt and valid schema", () => {
    const result = { name: "result", kind: "result", mode: "ai", prompt: "Summarize the run" };
    expect(() => checkGraph(graphSchema.parse({ tasks: [result] }))).not.toThrow();
    for (const patch of [{ prompt: " " }, { entry: true }, { consumes: ["done"] }, { emits: ["done"] },
      { schedule: { cron: "* * * * *" } }, { resultSchema: { type: "invalid" } }]) {
      expect(() => checkGraph(graphSchema.parse({ tasks: [{ ...result, ...patch }] }))).toThrow();
    }
    expect(() => checkGraph(graphSchema.parse({ tasks: [result, { ...result, name: "another" }] }))).toThrow("only one result");
  });
});
