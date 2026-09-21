import type { Graph } from "@tabductor/engine";

export type FlowNode = { id: string; kind: "node" | "event"; name: string; x: number; y: number; external: boolean };
export type FlowEdge = { id: string; from: string; to: string; eventType: string };
export type FlowLayout = { nodes: FlowNode[]; edges: FlowEdge[]; width: number; height: number };
export const flowId = (kind: "node" | "event", name: string): string => `${kind}:${name}`;

/** Collapse cycles before ranking. Branches, joins, external inputs and feedback loops
 * remain visible, including declarations with no producer or consumer. */
export function layoutFlow(graph: Graph): FlowLayout {
  const types = [...new Set([...graph.events.map((e) => e.type), ...graph.tasks.flatMap((t) => [...t.emits, ...t.consumes])])];
  const nodes: FlowNode[] = [
    ...graph.tasks.map((t) => ({ id: flowId("node", t.name), kind: "node" as const, name: t.name, x: 0, y: 0, external: false })),
    ...types.map((name) => ({ id: flowId("event", name), kind: "event" as const, name, x: 0, y: 0, external: !graph.tasks.some((t) => t.emits.includes(name)) })),
  ];
  const edges: FlowEdge[] = graph.tasks.flatMap((t) => [
    ...t.emits.map((type) => ({ id: `emit:${t.name}:${type}`, from: flowId("node", t.name), to: flowId("event", type), eventType: type })),
    ...t.consumes.map((type) => ({ id: `consume:${t.name}:${type}`, from: flowId("event", type), to: flowId("node", t.name), eventType: type })),
  ]);
  const adjacency = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.from)!.push(edge.to);
  const indices = new Map<string, number>();
  const lows = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const groups: string[][] = [];
  function visit(id: string): void {
    indices.set(id, indices.size);
    lows.set(id, indices.get(id)!);
    stack.push(id);
    active.add(id);
    for (const next of adjacency.get(id)!) {
      if (!indices.has(next)) {
        visit(next);
        lows.set(id, Math.min(lows.get(id)!, lows.get(next)!));
      } else if (active.has(next)) lows.set(id, Math.min(lows.get(id)!, indices.get(next)!));
    }
    if (lows.get(id) === indices.get(id)) {
      const group: string[] = [];
      let popped: string;
      do { popped = stack.pop()!; active.delete(popped); group.unshift(popped); } while (popped !== id);
      groups.push(group);
    }
  }
  for (const node of nodes) if (!indices.has(node.id)) visit(node.id);
  const groupOf = new Map(groups.flatMap((members, index) => members.map((id) => [id, index] as const)));
  const starts = new Map<number, number>();
  function rank(group: number): number {
    if (starts.has(group)) return starts.get(group)!;
    const parents = edges.filter((e) => groupOf.get(e.to) === group && groupOf.get(e.from) !== group).map((e) => groupOf.get(e.from)!);
    const start = Math.max(0, ...parents.map((p) => rank(p) + groups[p]!.length));
    starts.set(group, start);
    return start;
  }
  const rows = new Map<number, number>();
  for (const node of nodes) {
    const group = groupOf.get(node.id)!;
    const column = rank(group) + groups[group]!.indexOf(node.id);
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    node.x = 40 + column * 252;
    node.y = 64 + row * 164;
  }
  // Finalizers have no event subscriptions, but visually belong after the traversal.
  const finalizers = new Set(graph.tasks.filter((task) => task.kind === "result").map((task) => flowId("node", task.name)));
  const lastColumn = Math.max(40, ...nodes.filter((node) => !finalizers.has(node.id)).map((node) => node.x));
  for (const node of nodes) if (finalizers.has(node.id)) { node.x = lastColumn + 252; node.y = 64; }
  return {
    nodes, edges,
    width: Math.max(720, ...nodes.map((n) => n.x + 240)),
    height: Math.max(360, ...nodes.map((n) => n.y + 164)),
  };
}

export function graphChanges(before: Graph, after: Graph): string[] {
  const changes: string[] = [];
  for (const t of after.tasks) {
    const prior = before.tasks.find((p) => p.name === t.name);
    if (!prior) changes.push(`Added step “${t.name}”.`);
    else if (JSON.stringify(prior) !== JSON.stringify(t)) changes.push(`Updated step “${t.name}”.`);
  }
  for (const t of before.tasks) if (!after.tasks.some((n) => n.name === t.name)) changes.push(`Removed step “${t.name}”.`);
  for (const e of after.events) {
    const prior = before.events.find((p) => p.type === e.type);
    if (!prior) changes.push(`Added event “${e.type}”.`);
    else if (JSON.stringify(prior) !== JSON.stringify(e)) changes.push(`Updated event “${e.type}”.`);
  }
  for (const e of before.events) if (!after.events.some((n) => n.type === e.type)) changes.push(`Removed event “${e.type}”.`);
  return changes;
}
