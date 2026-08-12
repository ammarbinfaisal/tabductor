"use client";

import Link from "next/link";
import { createStore } from "zustand/vanilla";
import { Stamp } from "./primitives.js";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { usePolling, useStoreBridge, type Store } from "../lib/store.js";

/**
 * The run inspector (U1.5): a run's header (status, mode, timings, error, failure detail)
 * over a paged timeline of its trace entries. Server-rendered once for the 404 case
 * (`app/workflows/[id]/runs/[runId]/page.tsx`), then this client component takes over and
 * polls — the same division as `runs-table.tsx`/`event-feed.tsx`.
 *
 * Not built on `createPagedStore` (`lib/paged-store.ts`): that store's shape is "a list plus
 * a filter", and this page is "one run detail plus a forward-paged list" — close enough to
 * tempt a fit, different enough that forcing it would mean routing the detail fetch through
 * `onLoaded`, which exists to derive filter state from loaded rows, not to smuggle a second
 * unrelated query through. Small enough to write directly, in the same idiom.
 */

type RunDetail = RouterOutputs["run"]["get"];
type TraceItem = RouterOutputs["run"]["trace"]["items"][number];

type InspectorState = {
  detail: RunDetail | null;
  trace: TraceItem[];
  cursors: Array<string | null>;
  nextCursor: string | null;
  error: string | null;
};

function createInspectorStore(runId: string): Store<InspectorState> & {
  refresh: () => Promise<void>;
  more: () => void;
} {
  const store = createStore<InspectorState>(() => ({
    detail: null,
    trace: [],
    cursors: [null],
    nextCursor: null,
    error: null,
  }));

  const refresh = async (): Promise<void> => {
    const before = store.getState();
    try {
      const [detail, ...pages] = await Promise.all([
        api.run.get.query({ runId }),
        ...before.cursors.map((cursor) => api.run.trace.query({ runId, cursor, limit: 100 })),
      ]);
      store.setState((state) => ({
        ...state,
        detail,
        trace: pages.flatMap((p) => p.items),
        nextCursor: pages.at(-1)?.nextCursor ?? null,
        error: null,
      }));
    } catch (err) {
      store.setState((state) => ({ ...state, error: asApiError(err).message }));
    }
  };

  return {
    ...store,
    refresh,
    more() {
      const { nextCursor, cursors } = store.getState();
      if (!nextCursor) return;
      store.setState((state) => ({ ...state, cursors: [...cursors, nextCursor] }));
      void refresh();
    },
  };
}

/** One store per run, kept across renders — the same reason `pagedStoreFor` exists. */
const stores = new Map<string, ReturnType<typeof createInspectorStore>>();
const MAX_STORES = 8;

function storeFor(runId: string): ReturnType<typeof createInspectorStore> {
  const existing = stores.get(runId);
  if (existing) return existing;
  const created = createInspectorStore(runId);
  stores.set(runId, created);
  if (stores.size > MAX_STORES) stores.delete(stores.keys().next().value!);
  return created;
}

/** The two codes the testkit's scripted executor uses today for these two failure kinds
 * (§8, §15) — `runs.error` is free text in general, but these are the two the harness
 * itself writes verbatim, so they are the two worth a dedicated detail lookup. */
const FAILURE_CODES = new Set(["resource_limit_exceeded", "browser.disconnected"]);

/** The most recent failed action — where a resource-limit breach names the limit it tripped
 * (`session.ts`'s `limitBreach`) and a disconnect names the driver call that hit it. Scans
 * only the trace pages currently loaded; a failure past the first "Load more" click needs
 * one more click before this finds it, same as any other paged view of the same data. */
function findFailureDetail(trace: TraceItem[]): Record<string, unknown> | null {
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const entry = trace[i]!;
    if (entry.kind !== "action") continue;
    const payload = entry.payloadJson as Record<string, unknown>;
    if (payload.ok === false) return payload;
  }
  return null;
}

export function RunInspector({ workflowId, runId }: { workflowId: string; runId: string }) {
  const store = storeFor(runId);
  const state = useStoreBridge(store);
  usePolling(() => void store.refresh(), 2000);

  if (!state.detail) {
    return state.error ? (
      <div className="banner banner--error">The run didn&apos;t load. {state.error}</div>
    ) : (
      <p className="muted">Loading…</p>
    );
  }

  const { run, task, trigger } = state.detail;
  const showFailureDetail = run.error !== null && FAILURE_CODES.has(run.error);
  const failure = showFailureDetail ? findFailureDetail(state.trace) : null;

  return (
    <>
      <div className="row row--between" style={{ marginBottom: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--text-xl)" }}>
          {task.name} <span className="mono muted">{run.id.slice(0, 12)}</span>
        </h1>
        <Link href={`/workflows/${workflowId}/runs`} className="mono">
          Back to runs
        </Link>
      </div>

      <div className="entity-card entity-card--node" style={{ marginBottom: "var(--space-5)" }}>
        <div className="row">
          <Stamp kind={run.status} />
          <span className="mono muted">mode {run.modeUsed}</span>
          <span className="mono muted">attempt {run.attempt}</span>
          <span className="mono muted">
            {run.startedAt ? `started ${run.startedAt.toLocaleString()}` : "not started"}
          </span>
          {run.endedAt ? <span className="mono muted">ended {run.endedAt.toLocaleString()}</span> : null}
        </div>

        {run.error ? (
          <div className="banner banner--error">
            <strong className="mono">{run.error}</strong>
            {showFailureDetail ? (
              failure ? (
                <pre className="mono">{JSON.stringify(failure, null, 2)}</pre>
              ) : (
                <p className="muted">
                  No matching trace entry in the pages loaded so far — try Load more below.
                </p>
              )
            ) : null}
          </div>
        ) : null}

        {trigger ? (
          <p className="muted">
            triggered by{" "}
            <Link className="mono" href={`/workflows/${workflowId}/events?event=${trigger.eventId}`}>
              {trigger.type}
            </Link>
          </p>
        ) : (
          <p className="muted">No trigger event recorded for this run.</p>
        )}
      </div>

      {state.error ? <div className="banner banner--error">Refresh failed. {state.error}</div> : null}

      <h2 style={{ marginBottom: "var(--space-3)" }}>Timeline</h2>
      {state.trace.length === 0 ? (
        <p className="muted">No trace entries yet.</p>
      ) : (
        <div className="stack trace-timeline">
          {state.trace.map((entry) => (
            <TraceRow key={entry.seq} entry={entry} />
          ))}
        </div>
      )}
      {state.nextCursor ? <button onClick={() => store.more()}>Load more</button> : null}
    </>
  );
}

function TraceRow({ entry }: { entry: TraceItem }) {
  const payload = entry.payloadJson as Record<string, unknown>;
  const denied = entry.kind === "policy_denied";
  const screenshotRef = entry.kind === "action" && payload.action === "screenshot" ? entry.blobRef : null;

  return (
    <div className={`trace-row${denied ? " trace-row--denied" : ""}`}>
      <span className="mono muted trace-row-seq">{entry.seq}</span>
      <span className={`chip trace-row-kind${denied ? " trace-row-kind--denied" : ""}`}>{entry.kind}</span>
      <div className="stack" style={{ gap: "var(--space-1)", flex: 1, minWidth: 0 }}>
        <TraceSummary kind={entry.kind} payload={payload} />
        {screenshotRef ? (
          <img
            src={`/api/blobs/${encodeURIComponent(screenshotRef)}`}
            alt="run screenshot"
            className="trace-screenshot"
          />
        ) : null}
        <details>
          <summary className="mono muted trace-row-raw-summary">raw</summary>
          <pre className="mono">{JSON.stringify(payload, null, 2)}</pre>
        </details>
      </div>
      <span className="mono muted trace-row-time">{entry.createdAt.toLocaleTimeString()}</span>
    </div>
  );
}

function TraceSummary({ kind, payload }: { kind: TraceItem["kind"]; payload: Record<string, unknown> }) {
  switch (kind) {
    case "navigation":
      return (
        <span className="mono">
          {String(payload.url)} <span className="muted">· {String(payload.cause)} · allowed</span>
        </span>
      );
    case "action":
      return (
        <span className="mono">
          {String(payload.action)}{" "}
          <span className="muted">
            {payload.ok === false ? `· failed: ${String(payload.error ?? "")}` : "· ok"}
            {typeof payload.duration_ms === "number" ? ` · ${payload.duration_ms}ms` : ""}
          </span>
        </span>
      );
    case "network":
      return (
        <span className="mono">
          {String(payload.method)} {String(payload.url)}{" "}
          <span className="muted">· {payload.status === null || payload.status === undefined ? "pending" : String(payload.status)}</span>
        </span>
      );
    case "policy_denied":
      return (
        <span className="mono">
          {String(payload.check)} denied <span className="muted">· rule {String(payload.rule)}</span>
        </span>
      );
    case "llm":
      return <span className="mono muted">llm call</span>;
    default:
      return null;
  }
}
