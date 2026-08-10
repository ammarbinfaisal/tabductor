"use client";

import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { PublicGraph } from "@tabductor/engine";
import { toFlowEdges, toFlowNodes } from "../lib/graph-flow.js";
import { NODE_KINDS } from "../lib/node-kinds.js";

/**
 * The graph as a share viewer sees it (U0.5).
 *
 * The same mapping the editor uses (`lib/graph-flow`), with every interaction turned off —
 * not a second renderer that happens to look similar. There is no store behind this and no
 * mutation reachable from it: the component takes a document and draws it.
 */
export function SharedGraph({ name, graph }: { name: string; graph: PublicGraph }) {
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{name}</h1>
        <span className="muted">read-only shared view</span>
      </div>

      <div className="editor">
        <div className="canvas">
          <ReactFlow
            nodes={toFlowNodes(graph.tasks)}
            edges={toFlowEdges(graph.edges)}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="side">
          <section>
            <h3>Nodes</h3>
            {graph.tasks.map((task) => (
              <div key={task.name} className="emit">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{task.name}</strong>
                  <span className="muted">
                    {NODE_KINDS[task.kind].label} · {task.mode}
                  </span>
                </div>
                {task.schedule ? (
                  <div className="mono muted">
                    {task.schedule.cron} {task.schedule.tz}
                    {task.schedule.enabled ? "" : " · disabled"}
                  </div>
                ) : null}
                {task.emits.length === 0 ? (
                  <div className="muted">emits nothing</div>
                ) : (
                  task.emits.map((emit) => (
                    <div key={emit.type} className="row" style={{ justifyContent: "space-between" }}>
                      <code>{emit.type}</code>
                      <span className="muted">{emit.public ? "shared" : "packet not shared"}</span>
                    </div>
                  ))
                )}
              </div>
            ))}
          </section>

          {graph.edges.length > 0 ? (
            <section>
              <h3>Edges</h3>
              {graph.edges.map((e) => (
                <div className="mono" key={`${e.from}|${e.eventType}|${e.to}`}>
                  {e.from} —[{e.eventType}]→ {e.to}
                </div>
              ))}
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}
