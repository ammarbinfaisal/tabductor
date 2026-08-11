"use client";

import type { Graph, TaskSummary } from "@tabductor/engine";
import Link from "next/link";
import { findCycles } from "../lib/topology.js";
import { useStoreBridge } from "../lib/store.js";
import { CompileReport } from "./compile-report.js";
import { DerivedMap } from "./derived-map.js";
import { createEditorStore, type EditorStore } from "./editor-store.js";
import { EventPanel } from "./event-panel.js";
import { NodePanel } from "./node-panel.js";
import { SectionLabel } from "./primitives.js";

/**
 * The declarative editor (U1, component-specs §4.2): header + compile report + banners,
 * the Events | Nodes panel row, and the derived Map. There is no canvas — wiring is
 * toggling a chip, and the map only ever draws what the declarations already say.
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
  eventSchemas: Record<string, Record<string, unknown>>;
  maxHops: number;
}) {
  // Rebuilt when the page is showing a different workflow than the one the store holds —
  // otherwise navigating between two graphs would edit the first one's document.
  if (!store || store.getState().workflowId !== props.workflowId) store = createEditorStore(props);
  const s = store;
  const state = useStoreBridge(s);
  const cycles = findCycles(state.graph.tasks);
  const failedEntries = (state.compileReport ?? []).filter((e) => e.status === "failed");
  const empty = state.graph.tasks.length === 0 || state.graph.events.length === 0;

  const publishReason = empty
    ? "Publish needs at least one event and one node."
    : !state.dirty && state.versionId
      ? `Everything here is already published as ${state.versionId}.`
      : null;

  return (
    <>
      <div className="row row--between editor-header">
        <span>
          <span className="section-label">
            <Link href="/workflows">Workflows</Link> /
          </span>
          <h1 style={{ display: "inline", marginLeft: "var(--space-2)" }}>{props.workflowName}</h1>
          <span className="section-label" style={{ marginLeft: "var(--space-3)" }}>
            {state.versionId
              ? state.dirty
                ? `${state.versionId} · unpublished edits`
                : state.versionId
              : "draft · never published"}
          </span>
        </span>
        <span className="row" style={{ flexDirection: "column", alignItems: "flex-end", gap: "var(--space-1)" }}>
          <span className="row">
            <button className="btn--quiet" onClick={() => void s.reload()} disabled={state.busy}>
              Reload
            </button>
            <button
              className="btn--primary"
              disabled={state.busy || publishReason !== null}
              aria-describedby="publish-reason"
              onClick={() => void s.save()}
            >
              Publish
            </button>
          </span>
          {publishReason ? (
            <span id="publish-reason" className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {publishReason}
            </span>
          ) : null}
        </span>
      </div>

      {state.compileReport ? (
        <CompileReport
          entries={state.compileReport}
          versionId={state.versionId}
          failed={failedEntries.length > 0}
          onDismiss={() => s.setState({ compileReport: null })}
        />
      ) : null}

      {failedEntries.map((entry) => (
        <div key={entry.type} className="banner banner--error">
          <span className="mono">◈ {entry.type}</span> didn&apos;t compile:{" "}
          <span className="mono">&ldquo;{entry.error}&rdquo;</span>. The schema comes from the prose —
          edit the description, then publish again. Nothing was published;{" "}
          {state.versionId ? <span className="mono">{state.versionId}</span> : "the draft"} is
          unchanged.{" "}
          <button className="btn--quiet mono" onClick={() => s.select({ kind: "event", id: entry.type })}>
            Go to ◈ {entry.type} ↓
          </button>
        </div>
      ))}
      {state.error && failedEntries.length === 0 ? (
        <div className="banner banner--error">
          {state.error.message}
          {Object.keys(state.error.details).length > 0 ? (
            <span className="mono"> — {JSON.stringify(state.error.details)}</span>
          ) : null}
        </div>
      ) : null}
      {state.notice ? <div className="banner">{state.notice}</div> : null}
      {cycles.length > 0 ? (
        <div className="banner banner--warning">
          This graph loops: <span className="mono">{cycles[0]!.join(" → ")}</span>. Loops are allowed
          and capped at {props.maxHops} hops per causation chain.
        </div>
      ) : null}

      {state.confirmVisibility ? (
        <div className="modal-overlay" onClick={() => s.cancelVisibilityChange()}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
            <h2 style={{ fontSize: "var(--text-xl)" }}>This publish changes what share links show</h2>
            <p>Anyone with a share link sees the difference immediately.</p>
            {state.confirmVisibility.adding.length > 0 ? (
              <>
                <SectionLabel>Becoming public</SectionLabel>
                <div className="ruled">
                  {state.confirmVisibility.adding.map((t) => (
                    <div key={t} className="mono" style={{ fontSize: "var(--text-sm)" }}>
                      ◈ {t} — packet contents become readable by anyone with a link
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            {state.confirmVisibility.removing.length > 0 ? (
              <>
                <SectionLabel>Becoming hidden</SectionLabel>
                <div className="ruled">
                  {state.confirmVisibility.removing.map((t) => (
                    <div key={t} className="mono" style={{ fontSize: "var(--text-sm)" }}>
                      ◈ {t} — packet no longer readable, past events included; the event itself stays
                      listed
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            <div className="row" style={{ justifyContent: "flex-end", marginTop: "var(--space-5)" }}>
              <button className="btn--quiet" autoFocus onClick={() => s.cancelVisibilityChange()}>
                Cancel
              </button>
              <button className="btn--primary" onClick={() => void s.save(true)}>
                Publish with these changes
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="editor-panels">
        <EventPanel store={s} state={state} />
        <NodePanel store={s} state={state} />
      </div>

      <section className="map-region">
        <SectionLabel>Map</SectionLabel>
        <DerivedMap
          tasks={state.graph.tasks}
          kinds={Object.fromEntries(state.graph.tasks.map((t) => [t.name, t.kind]))}
          maxHops={props.maxHops}
        />
      </section>
    </>
  );
}
