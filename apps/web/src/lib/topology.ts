/**
 * The derived topology, in one place (EC1/U1).
 *
 * Nothing in the document is an edge; the picture is computed — emitters of a type feed
 * its consumers — and both the editor's map and the public view derive it through here,
 * which is the only honest way to keep two renderings showing the same graph. The input
 * is the structural minimum both satisfy (the editor's `GraphTask` and the public read
 * model's `PublicGraphTask`), so neither widens for the other.
 */

export type TopologyTask = {
  name: string;
  emits: readonly string[];
  consumes: readonly string[];
  schedule: { cron: string } | null;
};

export type DerivedEdge = { from: string; eventType: string; to: string };

export const edgeId = (e: DerivedEdge): string => `${e.from}|${e.eventType}|${e.to}`;

export function deriveEdges(tasks: readonly TopologyTask[]): DerivedEdge[] {
  const consumersOf = new Map<string, string[]>();
  for (const t of tasks) {
    for (const type of t.consumes) {
      const list = consumersOf.get(type);
      if (list) list.push(t.name);
      else consumersOf.set(type, [t.name]);
    }
  }
  return tasks.flatMap((t) =>
    t.emits.flatMap((type) => (consumersOf.get(type) ?? []).map((to) => ({ from: t.name, eventType: type, to }))),
  );
}

/**
 * The bipartite layout the map renders: alternating layers of nodes and events, assigned
 * by longest-path layering over the derived structure. Cycles are broken for *layout only*
 * (a back-edge keeps its meaning, it just points upward); the loop budget bounds them at
 * runtime and `findCycles` names them for the banner.
 */
export type MapVertex =
  | { kind: "task"; id: string; layer: number }
  | { kind: "event"; id: string; layer: number };

export function layerBipartite(tasks: readonly TopologyTask[]): MapVertex[] {
  // Vertices: every task, plus every event type any task touches (consumed external
  // types included — they are real triggers even with no in-graph emitter).
  const eventTypes = new Set<string>();
  for (const t of tasks) for (const type of [...t.emits, ...t.consumes]) eventTypes.add(type);

  const succ = new Map<string, string[]>();
  const push = (from: string, to: string) => {
    const list = succ.get(from);
    if (list) list.push(to);
    else succ.set(from, [to]);
  };
  const taskKey = (name: string) => `task:${name}`;
  const eventKey = (type: string) => `event:${type}`;
  for (const t of tasks) {
    for (const type of t.emits) push(taskKey(t.name), eventKey(type));
    for (const type of t.consumes) push(eventKey(type), taskKey(t.name));
  }

  // Longest path from any root, DFS with an on-path set so cycles don't recurse forever.
  const layer = new Map<string, number>();
  const onPath = new Set<string>();
  const assign = (key: string, depth: number): void => {
    if (onPath.has(key)) return; // back-edge: layout ignores it, the banner names it
    if ((layer.get(key) ?? -1) >= depth) return;
    layer.set(key, depth);
    onPath.add(key);
    for (const next of succ.get(key) ?? []) assign(next, depth + 1);
    onPath.delete(key);
  };

  const hasIncoming = new Set([...succ.values()].flat());
  const keys = [
    ...tasks.map((t) => taskKey(t.name)),
    ...[...eventTypes].map((type) => eventKey(type)),
  ];
  for (const key of keys) if (!hasIncoming.has(key)) assign(key, 0);
  for (const key of keys) if (!layer.has(key)) assign(key, 0); // pure cycles have no root

  return keys.map((key) => {
    const [kind, id] = key.startsWith("task:")
      ? (["task", key.slice(5)] as const)
      : (["event", key.slice(6)] as const);
    return { kind, id, layer: layer.get(key) ?? 0 };
  });
}

/**
 * Cycles are legal — the loop budget bounds them (§18.6) — but invisible ones are how a
 * workflow quietly burns its hops, so the editor names every one it finds. DFS over the
 * derived edges with the current path on the stack, so the warning can quote the actual
 * cycle rather than "there is a cycle somewhere".
 */
export function findCycles(tasks: readonly TopologyTask[]): string[][] {
  const out = new Map<string, string[]>();
  for (const e of deriveEdges(tasks)) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const onPath: string[] = [];

  const walk = (node: string): void => {
    const at = onPath.indexOf(node);
    if (at !== -1) {
      cycles.push([...onPath.slice(at), node]);
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    onPath.push(node);
    for (const next of out.get(node) ?? []) walk(next);
    onPath.pop();
  };

  for (const task of tasks) walk(task.name);
  return cycles;
}
