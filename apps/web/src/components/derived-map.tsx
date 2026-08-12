"use client";

import { deriveEdges, findCycles, layerBipartite, type TopologyTask } from "../lib/topology.js";

/**
 * The derived Map (component-specs §3.3): read-only inline SVG over the bipartite
 * topology. No library, no canvas — inline so the DESIGN.md tokens cascade into
 * fill/stroke. The map is evidence, not theater: markers, edges, labels, and the one
 * LOOP annotation; re-renders in place with no transition.
 *
 * The public view renders this same component with the same inputs — nothing owner-only
 * exists in it.
 */

const SLOT = 160;
const GAP = 64;
const M = 32;
const ROW_GAP = 24;
const TASK_H = 44;
const EVENT_H = 28;

const slotX = (layer: number): number => M + layer * (SLOT + GAP);
const labelWidth = (chars: number): number => Math.min(Math.max(72, 16 + 7.2 * chars), SLOT);
const truncate = (text: string, max = 19): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type Marker = {
  kind: "task" | "event";
  id: string;
  label: string;
  kindWord?: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export function DerivedMap({
  tasks,
  kinds,
  maxHops,
}: {
  tasks: readonly TopologyTask[];
  /** Task name → kind word (`browser`/`asset`) — the redundancy word, never omitted. */
  kinds: Record<string, string>;
  maxHops: number;
}) {
  const vertices = layerBipartite(tasks);
  if (vertices.length === 0 || tasks.length === 0) {
    return (
      <p className="muted map-empty">
        The map draws itself from your declarations. It appears when a node consumes or emits an
        event.
      </p>
    );
  }

  // Columns: stack in input order, then vertically center each against the tallest.
  const byLayer = new Map<number, typeof vertices>();
  for (const v of vertices) byLayer.set(v.layer, [...(byLayer.get(v.layer) ?? []), v]);
  const columnHeight = (col: typeof vertices): number =>
    col.reduce((h, v) => h + (v.kind === "task" ? TASK_H : EVENT_H), 0) + ROW_GAP * (col.length - 1);
  const tallest = Math.max(...[...byLayer.values()].map(columnHeight));

  const markers = new Map<string, Marker>();
  for (const [layer, col] of byLayer) {
    let y = M + (tallest - columnHeight(col)) / 2;
    for (const v of col) {
      const h = v.kind === "task" ? TASK_H : EVENT_H;
      const label = v.kind === "event" ? `◈ ${truncate(v.id)}` : truncate(v.id);
      const kindWord = v.kind === "task" ? (kinds[v.id] ?? "browser") : undefined;
      const chars = Math.max(label.length, kindWord?.length ?? 0);
      const w = labelWidth(chars);
      markers.set(`${v.kind}:${v.id}`, {
        kind: v.kind,
        id: v.id,
        label,
        ...(kindWord === undefined ? {} : { kindWord }),
        x: slotX(v.layer) + (SLOT - w) / 2,
        y,
        w,
        h,
      });
      y += h + ROW_GAP;
    }
  }

  // Edges run node → event → node in the bipartite structure; the *derived* node→node
  // edges only decide which are cycle back-edges (a back-edge points to an earlier layer).
  type MapEdge = { from: Marker; to: Marker; back: boolean };
  const edges: MapEdge[] = [];
  for (const t of tasks) {
    const from = markers.get(`task:${t.name}`);
    for (const type of t.emits) {
      const to = markers.get(`event:${type}`);
      if (from && to) edges.push({ from, to, back: to.x < from.x });
    }
    for (const type of t.consumes) {
      const src = markers.get(`event:${type}`);
      const dst = markers.get(`task:${t.name}`);
      if (src && dst) edges.push({ from: src, to: dst, back: dst.x < src.x });
    }
  }

  const maxBottom = Math.max(...[...markers.values()].map((m) => m.y + m.h));
  const backEdges = edges.filter((e) => e.back);
  const width = Math.max(...[...markers.values()].map((m) => m.x + m.w)) + M;
  const height = maxBottom + (backEdges.length > 0 ? 24 + backEdges.length * 16 + 24 : 0) + M;

  const cycles = findCycles(tasks);
  const ariaEdges = deriveEdges(tasks)
    .map((e) => `${e.from} emits ${e.eventType}, consumed by ${e.to}`)
    .join("; ");

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        role="img"
        aria-label={`Workflow map: ${tasks.length} nodes and ${vertices.length - tasks.length} events. ${ariaEdges}.`}
        style={{ fontFamily: "var(--font-mono)", fontSize: 12, display: "block" }}
      >
        <defs>
          <marker id="map-arrow" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="var(--map-edge)" />
          </marker>
        </defs>

        <g stroke="var(--map-edge)" strokeWidth="1">
          {edges
            .filter((e) => !e.back)
            .map((e, i) => (
              <line
                key={i}
                x1={e.from.x + e.from.w}
                y1={e.from.y + e.from.h / 2}
                x2={e.to.x}
                y2={e.to.y + e.to.h / 2}
                markerEnd="url(#map-arrow)"
              />
            ))}
        </g>

        {backEdges.map((e, i) => {
          const channelY = maxBottom + 24 + i * 16;
          const sx = e.from.x + e.from.w / 2;
          const tx = e.to.x + e.to.w / 2;
          const midX = (sx + tx) / 2;
          return (
            <g key={`back-${i}`}>
              <path
                d={`M${sx},${e.from.y + e.from.h} V${channelY} H${tx} V${e.to.y + e.to.h + 6}`}
                fill="none"
                stroke="var(--map-edge)"
                strokeWidth="1"
                strokeLinejoin="miter"
                markerEnd="url(#map-arrow)"
              />
              <g transform={`translate(${midX - 60},${channelY - 19})`}>
                <rect width="46" height="16" rx="2" fill="none" stroke="var(--map-annotation)" strokeWidth="1.5" />
                <text x="23" y="12" textAnchor="middle" fill="var(--map-annotation)" fontWeight="500" letterSpacing="0.08em">
                  LOOP
                </text>
                <text x="54" y="12" fill="var(--map-annotation)">
                  capped at {maxHops} hops
                </text>
              </g>
            </g>
          );
        })}

        {[...markers.values()].map((m) => {
          // `decision` renders in the third entity family (`--decision-*`, globals.css) —
          // the map is the one surface besides the kind badge where `browser`/`asset` and
          // `decision` sit side by side, so the same distinction the node panel draws with a
          // badge class has to hold here too, not just in the panel.
          if (m.kind === "task") {
            const isDecision = m.kindWord === "decision";
            const fill = isDecision ? "var(--decision-bg)" : "var(--node-bg)";
            const stroke = isDecision ? "var(--decision-border)" : "var(--node-border)";
            const text = isDecision ? "var(--decision-text)" : "var(--node-text)";
            return (
              <g key={`task:${m.id}`}>
                <rect x={m.x} y={m.y} width={m.w} height={m.h} fill={fill} stroke={stroke} strokeWidth="1.5" />
                <text x={m.x + m.w / 2} y={m.y + 18} textAnchor="middle" fill={text} fontWeight="500">
                  {m.label}
                  <title>{m.id}</title>
                </text>
                <text x={m.x + m.w / 2} y={m.y + 34} textAnchor="middle" fill={text}>
                  {m.kindWord}
                </text>
              </g>
            );
          }
          return (
            <g key={`event:${m.id}`}>
              <rect x={m.x} y={m.y} width={m.w} height={m.h} rx="2" fill="var(--event-bg)" stroke="var(--event-border)" strokeWidth="1.5" />
              <text x={m.x + m.w / 2} y={m.y + 18} textAnchor="middle" fill="var(--event-text)" fontWeight="500">
                {m.label}
                <title>{m.id}</title>
              </text>
            </g>
          );
        })}
      </svg>
      {cycles.length > 0 ? null : null}
    </div>
  );
}
