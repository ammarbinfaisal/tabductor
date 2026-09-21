import { expect, it } from "vitest";
import { graphSchema } from "./graph.js";
import { checkRecordContracts } from "./record-contracts.js";

const graph = graphSchema.parse({ tasks: [{ name: "prepare", kind: "decision", consumes: ["source"], emits: ["destination"] }],
  events: [{ type: "source", description: "Source" }, { type: "destination", description: "Destination" }] });
const schema = (type: unknown, required = true) => ({ type: "object", properties: { flag: { type } }, required: required ? ["flag"] : [] });

it("rejects silently narrowing shared field types or unknown optional values", () => {
  for (const [source, destination] of [
    [schema(["boolean", "null"]), schema(["integer", "null"])],
    [schema("integer", false), schema("integer")],
    [schema(["integer", "null"]), schema("integer")],
  ]) expect(() => checkRecordContracts(graph, new Map([["source", source!], ["destination", destination!]]))).toThrow();
});

it("permits nullable optional values and lossless integer-to-number widening", () => {
  for (const [source, destination] of [
    [schema("integer", false), schema(["integer", "null"])],
    [schema("integer"), schema("number")],
    [schema(["boolean", "null"]), schema(["boolean", "null"])],
  ]) expect(() => checkRecordContracts(graph, new Map([["source", source!], ["destination", destination!]]))).not.toThrow();
});
