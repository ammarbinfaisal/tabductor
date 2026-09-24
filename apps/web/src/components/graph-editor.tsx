"use client";

import type {
  Graph,
  PersistedGraphCompileReport,
  ProposedGrant,
  TaskSummary,
} from "@tabductor/engine";
import Link from "next/link";
import { resultSchemaTextOf } from "../lib/result-schema.js";
import { useStoreBridge } from "../lib/store.js";
import {
  createEditorStore,
  workflowScheduleOf,
  type EditorState,
  type EditorStore,
} from "./editor-store.js";
import { SectionLabel } from "./primitives.js";
import { WorkflowWorkspace } from "./workflow-workspace.js";

/** Graph, packet traces and conversational changes share one workflow document. */
let store: EditorStore | undefined;

export function GraphEditor(props: {
  workflowId: string;
  workflowName: string;
  versionId: string | null;
  graph: Graph;
  tasks: TaskSummary[];
  eventSchemas: Record<string, Record<string, unknown>>;
  authoring: {
    report: PersistedGraphCompileReport | null;
    proposedGrants: Array<ProposedGrant & { id: string }>;
  } | null;
  maxHops: number;
  showGraph?: boolean;
  initialEventId?: string;
}) {
  // Rebuilt when the page is showing a different workflow than the one the store holds —
  // otherwise navigating between two graphs would edit the first one's document.
  if (!store || store.getState().workflowId !== props.workflowId) store = createEditorStore(props);
  const s = store;
  const state = useStoreBridge(s);
  const empty = state.graph.tasks.length === 0;
  const promptChanged = state.automationPrompt.trim() !== (state.graph.automationPrompt ?? "");

  const schemaChanged = state.resultSchemaText !== resultSchemaTextOf(state.graph);
  const publishReason = !state.automationPrompt.trim() && (empty || promptChanged || schemaChanged)
    ? "Enter a workflow prompt before publishing."
    : !empty && !state.dirty && !promptChanged && !schemaChanged && state.versionId
      ? "All changes published."
      : null;
  const operationReason = !state.versionId
    ? "Publish the workflow first."
    : state.dirty || promptChanged || schemaChanged
      ? "Publish the current edits first."
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
              ? state.dirty || promptChanged || schemaChanged
                ? "Unpublished changes"
                : "Published"
              : "draft · never published"}
          </span>
        </span>
        <span className="row" style={{ flexDirection: "column", alignItems: "flex-end", gap: "var(--space-1)" }}>
          <span className="row">
            <button
              className="btn--primary"
              onClick={() => void s.triggerWorkflow().then(result => {
                if (!result) return;
                const runId = result.runs.find(run => run.runId)?.runId;
                window.location.assign(runId ? `/workflows/${state.workflowId}/runs/${runId}` : `/workflows/${state.workflowId}/runs`);
              })}
              disabled={state.busy || operationReason !== null}
              title={operationReason ?? "Start the published workflow now"}
            >
              Run workflow ↗︎
            </button>
            <button className="btn--quiet" onClick={() => void s.reload()} disabled={state.busy}>
              Reload
            </button>
            <button
              className={operationReason ? "btn--primary" : ""}
              disabled={state.busy || publishReason !== null}
              aria-describedby={publishReason ? "publish-reason" : undefined}
              onClick={() => void s.save()}
            >
              {state.publishing ? "Publishing…" : "Publish"}
            </button>
          </span>
          {publishReason ? (
            <span id="publish-reason" className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {publishReason}
            </span>
          ) : null}
        </span>
      </div>

      {state.error ? (
        <div className="banner banner--error">
          {state.error.message}
        </div>
      ) : null}
      {state.notice ? <div className="banner">{state.notice}</div> : null}

      <nav className="automation-tabs" aria-label="Workflow views">
        {(["automation", "activity", ...(props.showGraph ? ["graph" as const] : [])] as const).map((tab) => <button key={tab}
          aria-current={state.workspaceTab === tab ? "page" : undefined}
          onClick={() => s.setWorkspaceTab(tab)}>{tab === "automation" ? "Automation" : tab === "activity" ? "Activity" : "Graph"}</button>)}
      </nav>
      {state.workspaceTab === "automation" || (state.workspaceTab === "graph" && !props.showGraph) ? <div className="automation-workspace">
        <section className="automation-brief" aria-label="Automation prompt">
          <SectionLabel>Direct the workflow</SectionLabel>
          <h2>One prompt. A repeatable routine.</h2>
          <p>One prompt directs the entire workflow: its steps, constraints, and final result. Add a schema if you need a specific JSON output.</p>
          <label className="field"><span>Workflow prompt</span><textarea value={state.automationPrompt} disabled={state.busy} maxLength={20000}
            placeholder="Open X, collect 100 unique tweets from my For You timeline, and add them to my Notion database at… Skip tweets already saved and verify each new entry."
            onChange={(event) => s.setAutomationPrompt(event.target.value)} /></label>
          <details className="advanced-options"><summary>Result schema <span className="muted">Optional</span></summary>
          <label className="field"><span>Result schema (JSON Schema draft-07)</span>
            <textarea className="mono" rows={7} disabled={state.busy} value={state.resultSchemaText}
              placeholder={'{ "type": "object", "properties": { "summary": { "type": "string" } }, "required": ["summary"] }'}
              onChange={(event) => s.setResultSchemaText(event.target.value)} /></label>
          <p className="muted">Leave empty for free-form JSON. The final result follows your workflow prompt.</p></details>
          <p className="muted">Publish to make your automation ready to run. No schedule specified? It runs on demand.</p>
          {state.graph.tasks.length ? <div className="automation-outline"><h3>What it will do</h3><ol>{state.graph.tasks.map((task) => <li key={task.name}><strong>{task.label ?? task.name}</strong>{task.summary ? <p>{task.summary}</p> : null}</li>)}</ol></div> : null}
        </section>
      </div> : <WorkflowWorkspace
        key={`${state.workflowId}:${state.versionId ?? "draft"}`}
        editor={s}
        state={state}
        showGraph={props.showGraph === true && state.workspaceTab === "graph"}
        {...(props.initialEventId ? { initialEventId: props.initialEventId } : {})}
      />}
      <details className="workflow-schedule-details">
        <summary>Schedule & automatic runs</summary>
        <WorkflowSchedule store={s} state={state} operationReason={operationReason} />
      </details>

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
              <button className="btn--primary" disabled={state.busy} onClick={() => void s.save(true)}>
                Publish with these changes
              </button>
            </div>
          </div>
        </div>
      ) : null}

    </>
  );
}

function WorkflowSchedule({
  store,
  state,
  operationReason,
}: {
  store: EditorStore;
  state: EditorState;
  operationReason: string | null;
}) {
  const published = workflowScheduleOf(state.graph);
  const hasSchedule = published.scheduledEntries > 0;
  const changed = published.distinctSchedules > 1
    || state.scheduleDraft.cron.trim() !== published.draft.cron
    || state.scheduleDraft.timezone.trim() !== published.draft.timezone
    || state.scheduleDraft.enabled !== published.draft.enabled;
  const blocked = state.busy || operationReason !== null;
  const summary = !hasSchedule
    ? "No automatic runs are scheduled."
    : published.distinctSchedules > 1
      ? `${published.distinctSchedules} automatic schedules are active. Publishing here replaces them with one schedule.`
      : `${published.draft.cron} · ${published.draft.timezone} · ${published.draft.enabled ? "enabled" : "paused"}`;

  return (
    <section className="workflow-automation" aria-labelledby="workflow-schedule-heading">
      <div className="workflow-automation__summary">
        <SectionLabel>Automatic runs</SectionLabel>
        <h2 id="workflow-schedule-heading">Schedule</h2>
        <p className="muted">{summary}</p>
        {operationReason ? <p className="muted">{operationReason}</p> : null}
      </div>
      <div className="workflow-schedule-form">
        <label className="field">
          <span>Cron expression</span>
          <input
            className="mono"
            aria-label="Cron expression"
            placeholder="0 7 * * *"
            value={state.scheduleDraft.cron}
            disabled={blocked}
            onChange={(event) => store.setScheduleDraft({ cron: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Timezone</span>
          <input
            className="mono"
            aria-label="Schedule timezone"
            placeholder="UTC"
            value={state.scheduleDraft.timezone}
            disabled={blocked}
            onChange={(event) => store.setScheduleDraft({ timezone: event.target.value })}
          />
        </label>
        <label className="workflow-schedule-toggle">
          <input
            type="checkbox"
            checked={state.scheduleDraft.enabled}
            disabled={blocked}
            onChange={(event) => store.setScheduleDraft({ enabled: event.target.checked })}
          />
          Enabled
        </label>
        <div className="row workflow-schedule-actions">
          {hasSchedule ? (
            <button className="btn--quiet" disabled={blocked} onClick={() => void store.publishSchedule(true)}>
              Remove
            </button>
          ) : null}
          <button
            className="btn--primary"
            disabled={blocked || !changed || !state.scheduleDraft.cron.trim() || !state.scheduleDraft.timezone.trim()}
            onClick={() => void store.publishSchedule()}
          >
            Publish schedule
          </button>
        </div>
      </div>
    </section>
  );
}
