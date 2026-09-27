import { expect, it } from "vitest";
import { checkGraph, graphSchema } from "./testing/graph.js";
const base = { contractVersion: 2, maxRuns: 20, externalInputs: [], systemInputs: [],
  tasks: [{ logicalId: "plan", name: "Plan", entry: true }], events: [] };
it("requires explicit v2 entries, logical identities, input declarations and budgets", () => {
  expect(() => checkGraph(graphSchema.parse(base))).not.toThrow();
  for (const change of [{ maxRuns: undefined }, { externalInputs: undefined }, { systemInputs: undefined },
    { tasks: [{ name: "missing identity", entry: true }] }, { tasks: [{ logicalId: "plan", name: "missing entry" }] }]) {
    expect(() => checkGraph(graphSchema.parse({ ...base, ...change }))).toThrow();
  }
  expect(() => checkGraph(graphSchema.parse({ ...base, tasks: [...base.tasks, { ...base.tasks[0], name: "Renamed" }] }))).toThrow("logical task identity");
});
it("rejects undeclared external subscriptions and accepts typed external and explicit system inputs", () => {
  const graph = { ...base, tasks: [{ ...base.tasks[0], consumes: ["incoming", "run.failed"] }] };
  expect(() => checkGraph(graphSchema.parse(graph))).toThrow("neither emitted nor declared");
  expect(() => checkGraph(graphSchema.parse({ ...graph, externalInputs: ["incoming"] }))).toThrow("requires an event schema");
  expect(() => checkGraph(graphSchema.parse({ ...graph, externalInputs: ["incoming"], systemInputs: ["run.failed"],
    events: [{ type: "incoming", description: "An incoming record." }] }))).not.toThrow();
});
