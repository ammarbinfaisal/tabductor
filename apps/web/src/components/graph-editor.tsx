"use client";

import {
  Background,
  Controls,
  ReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Graph, TaskSummary } from "@tabductor/engine";
import { edgeId, toFlowEdges, toFlowNodes } from "../lib/graph-flow.js";
import { KIND_LIST, NODE_KINDS } from "../lib/node-kinds.js";
import { useStoreBridge } from "../lib/store.js";
import { createEditorStore, findCycles, type EditorStore } from "./editor-store.js";

/**
 * The graph editor (U0). React Flow in controlled mode over the editor store: the store
 * holds the document, this renders it, and every interaction is a store action.
 *
 * The store is created once per mounted page. It is module-level rather than passed in
 * because a page owns exactly one graph at a time — the same shape the runs and events
 * pages use.
 */
let store: EditorStore | undefined;

export function GraphEditor(props: {
  workflowId: string;
  workflowName: string;
  versionId: string | null;
  graph: Graph;
  tasks: TaskSummary[];
}) {
  // Rebuilt when the page is showing a different workflow than the one the store holds —
  // otherwise navigating between two graphs would edit the first one's document.
  if (!store || store.getState().workflowId !== props.workflowId) store = createEditorStore(props);
  const s = store;
  const state = useStoreBridge(s);
  const cycles = findCycles(state.graph);
  const selected = state.graph.tasks.find((t) => t.name === state.selected) ?? null;
  const ConfigPanel = selected ? NODE_KINDS[selected.kind].configPanel : null;

  const nodes = toFlowNodes(state.graph.tasks, state.selected);
  const edges = toFlowEdges(state.graph.edges);

  const onNodesChange = (changes: NodeChange[]): void => {
    for (const change of changes) {
      if (change.type === "position" && change.position) s.moveNode(change.id, change.position);
      if (change.type === "select" && change.selected) s.select(change.id);
      if (change.type === "remove") s.removeNode(change.id);
    }
  };

  const onEdgesChange = (changes: EdgeChange[]): void => {
    for (const change of changes) if (change.type === "remove") s.removeEdge(change.id);
  };

  const onConnect = (c: Connection): void => {
    if (c.source && c.target) s.beginConnect(c.source, c.target);
  };

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{props.workflowName}</h1>
        <div className="row">
          <span className="muted mono">{state.versionId ?? "unpublished"}</span>
          <button onClick={() => void s.reload()} disabled={state.busy}>
            Reload
          </button>
          <button onClick={() => void s.save()} disabled={state.busy}>
            {state.dirty ? "Publish version •" : "Publish version"}
          </button>
        </div>
      </div>

      {state.error ? (
        <div className="banner banner-error">
          {state.error.message}
          {Object.keys(state.error.details).length > 0 ? (
            <span className="mono"> — {JSON.stringify(state.error.details)}</span>
          ) : null}
        </div>
      ) : null}
      {state.notice ? <div className="banner">{state.notice}</div> : null}
      {state.confirmVisibility ? (
        <div className="banner">
          <strong>This publish changes what share links expose.</strong>
          {state.confirmVisibility.adding.length > 0 ? (
            <div>
              Packets becoming readable by anyone with a link:{" "}
              <span className="mono">{state.confirmVisibility.adding.join(", ")}</span>
            </div>
          ) : null}
          {state.confirmVisibility.removing.length > 0 ? (
            <div>
              No longer readable, including past events:{" "}
              <span className="mono">{state.confirmVisibility.removing.join(", ")}</span>
            </div>
          ) : null}
          <div className="row">
            <button onClick={() => void s.save(true)}>Publish anyway</button>
            <button onClick={() => s.cancelVisibilityChange()}>Cancel</button>
          </div>
        </div>
      ) : null}
      {cycles.length > 0 ? (
        <div className="banner">
          {cycles.length} cycle{cycles.length > 1 ? "s" : ""}:{" "}
          {cycles.map((c) => c.join(" → ")).join("; ")}. Legal — the workflow&apos;s{" "}
          <code>max_hops</code> loop budget bounds it — but every lap spends budget.
        </div>
      ) : null}

      <div className="editor">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={() => s.markDirty()}
            onConnect={onConnect}
            onPaneClick={() => s.select(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
          </ReactFlow>

          <div className="palette">
            {KIND_LIST.map((kind) => (
              <button key={kind} onClick={() => s.addNode(kind)} title={NODE_KINDS[kind].hint}>
                + {NODE_KINDS[kind].label}
              </button>
            ))}
          </div>
        </div>

        <aside className="side">
          {state.pending ? <PendingEdge store={s} /> : null}
          {selected && ConfigPanel ? (
            <ConfigPanel
              task={selected}
              taskId={state.taskIds[selected.name] ?? null}
              store={s}
              state={state}
            />
          ) : (
            <p className="muted">Select a node, or add one from the palette.</p>
          )}
          <EdgeList store={s} graph={state.graph} />
        </aside>
      </div>
    </>
  );
}

/**
 * An edge is (source, event type, target) — React Flow only draws the first and last, so a
 * new connection parks here until it is named. The source node's declared events are
 * offered as a datalist rather than a closed list: schedule fires and manual triggers are
 * event types no node declares, and the API allows them for exactly that reason.
 */
function PendingEdge({ store: s }: { store: EditorStore }) {
  const state = useStoreBridge(s);
  const pending = state.pending;
  if (!pending) return null;
  const declared = state.graph.tasks.find((t) => t.name === pending.from)?.emits ?? [];

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>
        {pending.from} → {pending.to}
      </h3>
      <div className="row">
        <input
          autoFocus
          list="declared-events"
          placeholder="event type"
          defaultValue={declared[0]?.type ?? ""}
          onKeyDown={(e) =>
            e.key === "Enter" ? s.completeConnect((e.target as HTMLInputElement).value) : undefined
          }
          id="pending-edge-type"
        />
        <datalist id="declared-events">
          {declared.map((d) => (
            <option key={d.type} value={d.type} />
          ))}
        </datalist>
        <button
          onClick={() =>
            s.completeConnect(
              (document.getElementById("pending-edge-type") as HTMLInputElement | null)?.value ?? "",
            )
          }
        >
          Add edge
        </button>
        <button onClick={() => s.cancelConnect()}>Cancel</button>
      </div>
    </div>
  );
}

function EdgeList({ store: s, graph }: { store: EditorStore; graph: Graph }) {
  if (graph.edges.length === 0) return null;
  return (
    <section>
      <h3>Edges</h3>
      {graph.edges.map((e) => (
        <div className="row" key={edgeId(e)} style={{ justifyContent: "space-between" }}>
          <span className="mono">
            {e.from} —[{e.eventType}]→ {e.to}
          </span>
          <button onClick={() => s.removeEdge(edgeId(e))}>×</button>
        </div>
      ))}
    </section>
  );
}
