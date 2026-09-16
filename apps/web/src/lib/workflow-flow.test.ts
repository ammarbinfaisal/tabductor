import { expect, it } from "vitest";
import type { Graph, GraphTask } from "@tabductor/engine";
import { graphChanges, layoutFlow } from "./workflow-flow.js";

const task = (name: string, consumes: string[], emits: string[]): GraphTask => ({ name, consumes, emits, kind: "browser", mode: "ai", prompt: name, limits: {}, schedule: null, position: null });

it("draws every branch, join, external input and terminal event with distinct positions", () => {
  const graph: Graph = {
    tasks: [task("start", ["schedule.fired"], ["item"]), task("inspect", ["item"], ["checked"]), task("audit", ["item"], ["audited"]), task("save", ["checked", "audited"], ["saved"])],
    events: ["item", "checked", "audited", "saved"].map((type) => ({ type, description: type, public: false })),
  };
  const flow = layoutFlow(graph);
  expect(flow.nodes).toHaveLength(9);
  expect(flow.edges).toHaveLength(9);
  expect(new Set(flow.nodes.map((n) => `${n.x}:${n.y}`)).size).toBe(flow.nodes.length);
  const positions = new Map(flow.nodes.map((n) => [n.id, n]));
  for (const edge of flow.edges) expect(positions.get(edge.to)!.x).toBeGreaterThan(positions.get(edge.from)!.x);
  expect(positions.get("event:schedule.fired")?.external).toBe(true);
  expect(flow.edges.filter((e) => e.from === "event:item")).toHaveLength(2);
  expect(flow.edges.filter((e) => e.to === "node:save")).toHaveLength(2);
});

it("keeps cycles and disconnected steps without duplicating or dropping routes", () => {
  const flow = layoutFlow({ tasks: [task("a", ["retry"], ["work"]), task("b", ["work"], ["retry"]), task("alone", [], [])], events: [] });
  expect(flow.nodes).toHaveLength(5);
  expect(flow.edges).toHaveLength(4);
  const positions = new Map(flow.nodes.map((n) => [n.id, n]));
  expect(flow.edges.some((e) => positions.get(e.to)!.x < positions.get(e.from)!.x)).toBe(true);
  expect(new Set(flow.nodes.map((n) => `${n.x}:${n.y}`)).size).toBe(5);
});

it("reports rewiring as a graph change without modifying the source", () => {
  const before: Graph = { tasks: [task("a", [], ["item"])], events: [] };
  const after: Graph = { tasks: [task("a", [], ["checked"]), task("review", ["checked"], [])], events: [] };
  expect(graphChanges(before, after)).toEqual(["Updated step “a”.", "Added step “review”."]);
  expect(before.tasks[0]?.emits).toEqual(["item"]);
});
