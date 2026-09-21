"use client";

import type { Graph } from "@tabductor/engine";
import Link from "next/link";
import { usePolling, useStoreBridge } from "../lib/store.js";
import { useMountHook } from "../lib/use-mount-hook.js";
import { flowId, layoutFlow, type FlowLayout } from "../lib/workflow-flow.js";
import { activityFor, type ActivityStore } from "./workflow-activity.js";
import type { EditorState, EditorStore, Selection } from "./editor-store.js";
import { readableName, eventName, taskSummary, eventSummary } from "../lib/workflow-labels.js";
import { Stamp } from "./primitives.js";

const layouts = new WeakMap<Graph, FlowLayout>();
function flowFor(graph: Graph): FlowLayout {
  let layout = layouts.get(graph);
  if (!layout) { layout = layoutFlow(graph); layouts.set(graph, layout); }
  return layout;
}

export function WorkflowWorkspace({ editor, state, showGraph = false, initialEventId }: {
  editor: EditorStore; state: EditorState; showGraph?: boolean; initialEventId?: string;
}) {
  const activity = activityFor(state.workflowId, state.versionId);
  const live = useStoreBridge(activity);
  usePolling(() => void activity.refresh(), 2500);
  useMountHook(() => {
    if (initialEventId) { void activity.openPacket(initialEventId); }
  });
  const flow = flowFor(state.graph);
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  const task = state.selected?.kind === "node" ? state.graph.tasks.find((t) => t.name === state.selected?.id) : undefined;
  const eventType = state.selected?.kind === "event" ? state.selected.id : null;
  const selectedId = state.selected ? flowId(state.selected.kind, state.selected.id) : null;
  const relevantTypes = task ? new Set([...task.emits, ...task.consumes]) : null;
  const visibleEvents = live.events.filter((e) => eventType ? e.type === eventType : relevantTypes ? relevantTypes.has(e.type) || e.sourceTaskName === task?.name : true);
  const visibleRuns = live.runs.filter((r) => live.packet ? r.id === live.packet.event.sourceRunId || live.packet.triggered.some((next) => next.id === r.id) : task ? r.taskName === task.name : eventType ? state.graph.tasks.some((t) => t.name === r.taskName && (t.consumes.includes(eventType) || t.emits.includes(eventType))) : true);
  const counts = new Map<string, number>();
  for (const e of live.events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const latestRuns = new Map(live.runs.slice().reverse().map((r) => [r.taskName, r]));
  const path = new Set<string>();
  const pathEdges = new Set<string>();
  if (live.packet) {
    for (const e of live.packet.lineage) {
      path.add(flowId("event", e.type));
      const source = Object.values(state.publishedTasks).find((t) => t.id === e.sourceTaskId);
      if (source) {
        path.add(flowId("node", source.name));
        if (e.sourceRunId) pathEdges.add(`emit:${source.name}:${e.type}`);
        const input = live.packet.lineage.find((parent) => parent.eventId === e.causationId);
        if (input) pathEdges.add(`consume:${source.name}:${input.type}`);
      }
    }
    for (const r of live.packet.triggered) {
      if (!Object.values(state.publishedTasks).some((t) => t.id === r.taskId)) continue;
      path.add(flowId("node", r.taskName));
      pathEdges.add(`consume:${r.taskName}:${live.packet.event.type}`);
    }
  }
  const choose = (selection: Selection): void => {
    activity.closePacket(); editor.select(selection);
    const node = selection ? nodes.get(flowId(selection.kind, selection.id)) : undefined;
    const viewport = document.getElementById("workflow-flow-viewport");
    if (node && viewport) viewport.scrollTo({ left: Math.max(0, node.x * live.zoom - viewport.clientWidth / 2 + 98 * live.zoom), top: Math.max(0, node.y * live.zoom - 100), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  const openPacket = (eventId: string, type?: string): void => {
    if (type) editor.select({ kind: "event", id: type });
    void activity.openPacket(eventId);
  };

  return (
    <div className="workflow-workspace workflow-workspace--inspection">
      <div className="workflow-workspace__main">
        {live.progress?.blocked ? <div className="banner" role="status"><strong>Blocked</strong> · {live.progress.blocked.message}</div> : null}
        {live.progress?.execution ? <section className="flow-selection" aria-label="Latest execution progress">
          <h2>Latest execution · {live.progress.execution.status}</h2>
          {live.progress.execution.records.tracked ? <>
            <p><strong>{live.progress.execution.records.saved} verified destination saves</strong> from {live.progress.execution.records.total} tracked records.</p>
            <p className="muted">Extracted, awaiting preparation: {live.progress.execution.records.extracted} · Prepared: {live.progress.execution.records.prepared} · Pending save: {live.progress.execution.records.pending} · Skipped: {live.progress.execution.records.skipped} · Rejected: {live.progress.execution.records.rejected} · Failed: {live.progress.execution.records.failed}</p>
          </> : <p className="muted">Record progress is unavailable for this execution. Step and packet counts do not establish destination saves.</p>}
        </section> : null}
        {showGraph ? <section className="flow-panel" aria-label="Workflow graph">
          <div className="flow-toolbar">
            <div><strong>Workflow graph</strong><span className="muted">{state.graph.tasks.length} steps · {state.graph.events.length} event types</span></div>
            <div className="row">
              <button className="btn--quiet" aria-label="Zoom out" onClick={() => activity.zoom(-0.15)}>−</button>
              <span className="mono flow-zoom">{Math.round(live.zoom * 100)}%</span>
              <button className="btn--quiet" aria-label="Zoom in" onClick={() => activity.zoom(0.15)}>+</button>
              <button className="btn--quiet" onClick={(e) => {
                const viewport = e.currentTarget.closest("section")?.querySelector(".flow-viewport");
                activity.fit((viewport?.clientWidth ?? 800) - 24, flow.width);
                viewport?.scrollTo({ left: 0, top: 0 });
              }}>Fit</button>
            </div>
          </div>
          {state.dirty ? <p className="flow-draft-note">Unpublished draft · activity below belongs to the published version.</p> : null}
          {flow.nodes.length === 0 ? (
            <div className="flow-empty"><h2>Start with what you want to happen.</h2><p>Write your workflow prompt and build it. Its steps and event routes will appear here.</p></div>
          ) : (
            <div id="workflow-flow-viewport" className="flow-viewport" tabIndex={0} aria-label="Scrollable workflow graph. Select a step or event to inspect it.">
              <div style={{ width: flow.width * live.zoom, height: flow.height * live.zoom, minHeight: 360 }}>
                <div className="flow-stage" style={{ width: flow.width, height: flow.height, transform: `scale(${live.zoom})` }}>
                  <svg width={flow.width} height={flow.height} className="flow-connections" aria-hidden="true">
                    <defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
                    {flow.edges.map((edge) => {
                      const from = nodes.get(edge.from)!; const to = nodes.get(edge.to)!;
                      const x1 = from.x + 196; const y1 = from.y + 60; const x2 = to.x; const y2 = to.y + 60;
                      const backwards = x2 < x1;
                      const d = backwards
                        ? `M ${x1} ${y1} C ${x1 + 42} ${y1} ${x1 + 42} ${y1 - 96} ${x1} ${y1 - 96} L ${x2 - 20} ${y2 - 96} Q ${x2 - 40} ${y2 - 96} ${x2 - 40} ${y2} L ${x2} ${y2}`
                        : x2 - x1 > 100 ? `M ${x1} ${y1} C ${x1 + 24} ${y1} ${x1 + 24} 28 ${x1 + 36} 28 L ${x2 - 36} 28 C ${x2 - 24} 28 ${x2 - 24} ${y2} ${x2} ${y2}`
                        : `M ${x1} ${y1} C ${x1 + 28} ${y1} ${x2 - 28} ${y2} ${x2} ${y2}`;
                      const highlighted = live.packet ? pathEdges.has(edge.id) : edge.from === selectedId || edge.to === selectedId;
                      return <path key={edge.id} d={d} markerEnd="url(#flow-arrow)" className={`flow-edge${highlighted ? " flow-edge--selected" : ""}${backwards ? " flow-edge--loop" : ""}`} />;
                    })}
                  </svg>
                  {flow.nodes.map((node) => {
                    const definition = state.graph.tasks.find((t) => t.name === node.name);
                    const latest = node.kind === "node" ? latestRuns.get(node.name) : undefined;
                    const selected = node.id === selectedId || path.has(node.id);
                    return (
                      <button key={node.id} style={{ left: node.x, top: node.y }} className={`flow-node flow-node--${node.kind}${selected ? " flow-node--selected" : ""}`} aria-pressed={selected} onClick={() => choose({ kind: node.kind, id: node.name })}>
                        <span className="flow-node__kind">{node.kind === "event" ? "◇ Event" : definition?.kind === "result" ? "◎ Result" : definition?.kind === "decision" ? "⑂ Decision" : "▣ Browser"}{node.external ? " · input" : ""}</span>
                        <strong>{node.kind === "node" ? readableName(node.name, definition?.label) : eventName(state.graph, node.name)}</strong>
                        <span className="flow-node__meta">{node.kind === "event"
                          ? `${counts.get(node.name) ?? 0} recent packets`
                          : latest ? <Stamp kind={latest.status} /> : definition?.kind === "result" ? "After all steps finish" : definition?.consumes.length ? "Waiting for input" : "Entry · workflow start"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <div className="flow-legend"><span>▣ Step</span><span>◇ Event packet route</span><span>→ Direction of flow</span><span>┄ Feedback loop</span></div>
        </section> : null}

        {live.packetLoading || live.packet || task || eventType ? <section className="flow-selection" aria-label="Selected workflow item">
          {live.packetLoading ? <p role="status">Loading packet and its path…</p> : live.packet ? <PacketInspector activity={activity} state={state} onOpen={openPacket} /> : <>
            <div className="row row--between"><span className="section-label">{task ? "Step overview" : "Event overview"}</span><button className="btn--quiet" onClick={() => choose(null)} aria-label="Close overview">Close ×</button></div>
            <h2>{task ? readableName(task.name, task.label) : eventName(state.graph, eventType!)}</h2>
            <p>{task ? taskSummary(task, state.graph) : eventSummary(state.graph.events.find((event) => event.type === eventType), state.graph, eventType!)}</p>
            <div className="flow-overview-routes">
              <div><h3>{task ? "Receives" : "Comes from"}</h3><div className="flow-chips">{task
                ? task.consumes.length ? task.consumes.map((type) => <button key={type} onClick={() => choose({ kind: "event", id: type })}>{eventName(state.graph, type)}</button>) : <span className="muted">Workflow start</span>
                : state.graph.tasks.filter((node) => node.emits.includes(eventType!)).map((node) => <button key={node.name} onClick={() => choose({ kind: "node", id: node.name })}>{readableName(node.name, node.label)}</button>)}</div></div>
              <div><h3>{task ? "Produces" : "Continues to"}</h3><div className="flow-chips">{task
                ? task.emits.map((type) => <button key={type} onClick={() => choose({ kind: "event", id: type })}>{eventName(state.graph, type)}</button>)
                : state.graph.tasks.filter((node) => node.consumes.includes(eventType!)).map((node) => <button key={node.name} onClick={() => choose({ kind: "node", id: node.name })}>{readableName(node.name, node.label)}</button>)}</div></div>
            </div>
          </>}
        </section> : null}

        <section className="flow-activity" aria-label="Workflow activity">
          <div className="flow-toolbar">
            <div className="row" role="group" aria-label="Activity view">
              <button className="btn--quiet" aria-pressed={live.tab === "packets"} onClick={() => activity.setTab("packets")}>Event packets <span className="mono">{visibleEvents.length}</span></button>
              <button className="btn--quiet" aria-pressed={live.tab === "runs"} onClick={() => activity.setTab("runs")}>Step runs <span className="mono">{visibleRuns.length}</span></button>
            </div>
            <span className="muted">{live.loading ? "Loading…" : "Live · every 2.5s"}</span>
          </div>
          {state.selected ? <div className="flow-filter"><span>Showing {state.selected.kind === "event" ? eventName(state.graph, state.selected.id) : readableName(state.selected.id, task?.label)}</span><button className="btn--quiet" onClick={() => choose(null)}>Show all</button></div> : null}
          {live.error ? <div className="banner banner--error" role="alert">{live.error}</div> : null}
          <div className="flow-activity__scroll">
            {live.tab === "packets" ? (
              <table className="ledger"><thead><tr><th>Event / source</th><th>Packet preview</th><th>Time</th></tr></thead><tbody>
                {visibleEvents.map((event) => <tr key={event.eventId} className={live.packetKey === event.eventId ? "flow-row--selected" : ""}>
                  <td><button className="flow-packet-button" onClick={() => openPacket(event.eventId, event.type)}>◇ {eventName(state.graph, event.type)}</button><span className="flow-cell-note">{event.sourceRunId ? readableName(event.sourceTaskName ?? "System") : "Workflow start"}</span></td>
                  <td><button className="flow-packet-preview mono" title="Inspect packet and follow its path" onClick={() => openPacket(event.eventId, event.type)}>{JSON.stringify(event.packet)}</button></td>
                  <td className="mono muted"><time dateTime={event.occurredAt.toISOString()}>{event.occurredAt.toLocaleTimeString()}</time></td>
                </tr>)}
              </tbody></table>
            ) : (
              <table className="ledger"><thead><tr><th>Step</th><th>Status</th><th>Input</th><th>Started</th></tr></thead><tbody>
                {visibleRuns.map((run) => <tr key={run.id}>
                  <td><Link href={`/workflows/${state.workflowId}/runs/${run.id}`}>{readableName(run.taskName)} ↗</Link>{run.error ? <span className="flow-cell-note">{run.error}</span> : null}</td>
                  <td><Stamp kind={run.status} /></td>
                  <td>{run.triggerEventId ? <button className="btn--quiet" onClick={() => openPacket(run.triggerEventId!)}>Input packet</button> : "—"}</td>
                  <td className="mono muted">{run.startedAt?.toLocaleTimeString() ?? "Queued"}</td>
                </tr>)}
              </tbody></table>
            )}
            {!live.loading && !(live.tab === "packets" ? visibleEvents.length : visibleRuns.length) ? <p className="flow-empty-note">{state.selected ? "No recent activity for this selection. Show all or load older activity." : "No activity yet. Run the published workflow to follow packets through the graph."}</p> : null}
          </div>
          {(live.tab === "packets" ? live.eventCursor : live.runCursor) ? <button className="btn--quiet" disabled={live.loading} onClick={() => void activity.more()}>Load older {live.tab === "packets" ? "packets" : "runs"}</button> : null}
        </section>
      </div>

    </div>
  );
}

function PacketInspector({ activity, state, onOpen }: { activity: ActivityStore; state: EditorState; onOpen: (id: string, type?: string) => void }) {
  const live = useStoreBridge(activity);
  const detail = live.packet!;
  const event = detail.event;
  return <div className="packet-inspector">
    <div className="row row--between"><span className="section-label">Packet inspector</span><button className="btn--quiet" onClick={() => activity.closePacket()}>Close</button></div>
    <h2>◇ {eventName(state.graph, event.type)}</h2>
    {event.sourceTaskId && !Object.values(state.publishedTasks).some((t) => t.id === event.sourceTaskId) ? <p className="flow-draft-note">This packet belongs to an earlier version. The canvas shows the current graph; use the producing run to inspect its original execution.</p> : null}
    <p className="mono muted">{event.occurredAt.toLocaleString()}</p>
    <h3>Path to this packet</h3>
    <ol className="packet-lineage">{detail.lineage.map((ancestor) => <li key={ancestor.eventId}><button aria-current={ancestor.eventId === event.eventId ? "step" : undefined} onClick={() => onOpen(ancestor.eventId, ancestor.type)}>{eventName(state.graph, ancestor.type)}</button></li>)}</ol>
    <h3>Packet data</h3><pre className="packet-json">{JSON.stringify(event.packet, null, 2)}</pre>
    {event.sourceRunId ? <Link href={`/workflows/${state.workflowId}/runs/${event.sourceRunId}`}>Inspect producing run ↗</Link> : <p className="muted">Workflow or system input</p>}
    <h3>Downstream runs</h3>
    {detail.triggered.length ? <ul className="packet-consumers">{detail.triggered.map((run) => <li key={run.id}><Link href={`/workflows/${state.workflowId}/runs/${run.id}`}>{readableName(run.taskName)} ↗</Link><Stamp kind={run.status} /></li>)}</ul> : <p className="muted">No downstream run recorded yet.</p>}
    <details><summary>Trace identifiers</summary><p className="mono">Packet: {event.eventId}</p><p className="mono">Parent: {event.causationId ?? "None (root)"}</p><p className="mono">Source run: {event.sourceRunId ?? "None"}</p></details>
  </div>;
}
