"use client";

import Link from "next/link";
import { createStore } from "zustand/vanilla";
import type { Page, RunListItem } from "@tabductor/engine";
import { api, asApiError } from "../lib/api.js";
import { usePolling, useStoreBridge } from "../lib/store.js";

/**
 * The runs table (U0): status filter, cursor pagination, and a cancel button on anything
 * still `queued` or `running`.
 *
 * Live by polling (the U0 liveness pattern). Paging and polling have to agree on one thing:
 * a refresh re-requests every page already loaded rather than only the first, or a run that
 * finishes on page 3 would never update while page 1 keeps ticking.
 */
const STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "cancelled"] as const;
type Status = (typeof STATUSES)[number];

type State = {
  workflowId: string;
  status: Status | "";
  items: RunListItem[];
  cursors: Array<string | null>;
  nextCursor: string | null;
  error: string | null;
};

const store = createStore<State>(() => ({
  workflowId: "",
  status: "",
  items: [],
  cursors: [null],
  nextCursor: null,
  error: null,
}));

async function refresh(): Promise<void> {
  const { workflowId, status, cursors } = store.getState();
  if (!workflowId) return;
  try {
    const pages: Array<Page<RunListItem>> = [];
    for (const cursor of cursors) {
      pages.push(
        await api.run.list.query({
          workflowId,
          ...(status ? { status } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 25,
        }),
      );
    }
    store.setState({
      items: pages.flatMap((p) => p.items),
      nextCursor: pages.at(-1)?.nextCursor ?? null,
      error: null,
    });
  } catch (err) {
    store.setState({ error: asApiError(err).message });
  }
}

export function RunsTable({ workflowId }: { workflowId: string }) {
  if (store.getState().workflowId !== workflowId) {
    store.setState({ workflowId, items: [], cursors: [null], nextCursor: null });
  }
  const state = useStoreBridge(store);
  usePolling(() => void refresh(), 2000);

  const setStatus = (status: Status | ""): void => {
    store.setState({ status, cursors: [null], items: [] });
    void refresh();
  };

  const cancel = async (runId: string): Promise<void> => {
    try {
      await api.run.cancel.mutate({ runId });
    } catch (err) {
      store.setState({ error: asApiError(err).message });
    }
    await refresh();
  };

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Runs</h1>
        <div className="row">
          <select value={state.status} onChange={(e) => setStatus(e.target.value as Status | "")}>
            <option value="">all statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="muted">{state.items.length} shown · refreshing every 2s</span>
        </div>
      </div>

      {state.error ? <div className="banner banner-error">{state.error}</div> : null}

      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Status</th>
            <th>Attempt</th>
            <th>Started</th>
            <th>Ended</th>
            <th>Error</th>
            <th>Trigger</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {state.items.map((run) => (
            <tr key={run.id}>
              <td>
                {run.taskName}
                <div className="mono muted">{run.id}</div>
              </td>
              <td>
                <span className={`status status-${run.status}`}>{run.status}</span>
              </td>
              <td>{run.attempt}</td>
              <td className="mono muted">{run.startedAt?.toLocaleTimeString() ?? "—"}</td>
              <td className="mono muted">{run.endedAt?.toLocaleTimeString() ?? "—"}</td>
              <td className="muted">{run.error ?? ""}</td>
              <td>
                {run.triggerEventId ? (
                  <Link
                    className="mono"
                    href={`/workflows/${workflowId}/events?event=${run.triggerEventId}`}
                  >
                    {run.triggerEventId.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                {run.status === "queued" || run.status === "running" ? (
                  <button onClick={() => void cancel(run.id)}>Cancel</button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {state.items.length === 0 ? <p className="muted">No runs yet. Trigger a node from the graph.</p> : null}
      {state.nextCursor ? (
        <button
          onClick={() => {
            store.setState({ cursors: [...store.getState().cursors, store.getState().nextCursor] });
            void refresh();
          }}
        >
          Load more
        </button>
      ) : null}
    </>
  );
}
