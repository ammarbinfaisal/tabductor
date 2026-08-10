"use client";

import type { Edge, Node } from "@xyflow/react";
import type { NodeKind } from "@tabductor/engine";
import { NODE_KINDS } from "./node-kinds.js";

/**
 * The graph → React Flow mapping, in one place (U0.5).
 *
 * The editor and the public view render the same picture, and the only honest way to keep
 * them showing the same picture is for there to be one mapping. Interaction is what differs:
 * the editor wires the change handlers, the public view passes none.
 *
 * The input type is the structural minimum both callers satisfy — the editor's `GraphTask`
 * and the public read model's `PublicGraphTask` — rather than either concrete type, so
 * neither side has to widen to accommodate the other.
 */

export type FlowTask = {
  name: string;
  kind: NodeKind;
  mode: string;
  position: { x: number; y: number } | null;
  schedule: { cron: string } | null;
};

export type FlowEdge = { from: string; eventType: string; to: string };

export const edgeId = (e: FlowEdge): string => `${e.from}|${e.eventType}|${e.to}`;

export function toFlowNodes(tasks: readonly FlowTask[], selected?: string | null): Node[] {
  return tasks.map((t) => ({
    id: t.name,
    position: t.position ?? { x: 0, y: 0 },
    selected: t.name === selected,
    data: {
      label: (
        <div className="node">
          <strong>{t.name}</strong>
          <div className="node-meta">
            {NODE_KINDS[t.kind].label} · {t.mode}
            {t.schedule ? ` · ${t.schedule.cron}` : ""}
          </div>
        </div>
      ),
    },
  }));
}

export function toFlowEdges(edges: readonly FlowEdge[]): Edge[] {
  return edges.map((e) => ({ id: edgeId(e), source: e.from, target: e.to, label: e.eventType }));
}
