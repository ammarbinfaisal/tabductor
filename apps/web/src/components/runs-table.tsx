"use client";

import Link from "next/link";
import { createStore } from "zustand/vanilla";
import { api, asApiError } from "../lib/api.js";
import { usePolling, useStoreBridge } from "../lib/store.js";

/**
 * The runs table (U0), parameterized by where its rows come from (U0.5).
 *
 * There is one implementation because there is one table: the owner's view and a share
 * viewer's differ only in which procedure loads a page and whether a run can be cancelled.
 * Two copies would drift, and the copy nobody is looking at is the public one.
 *
 * Live by polling. Paging and polling have to agree on one thing: a refresh re-requests
 * every page already loaded rather than only the first, or a run that finishes on page 3
 * would never update while page 1 keeps ticking.
 */
const STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "cancelled"] as const;
type Status = (typeof STATUSES)[number];

/** One row, after each side has adapted its own shape to the one the table renders. */
export type RunView = {
  /** Row identity: a real id for the owner, a share-scoped ref for a viewer. */
  key: string;
  taskName: string;
  status: string;
  attempt: number;
  startedAt: Date | null;
  endedAt: Date | null;
  /** The owner's error message, or a viewer's bounded error class. One column either way. */
  error: string | null;
  triggerHref: string | null;
  cancellable: boolean;
};

export type RunsSource = {
  /** Identity of the scope. The store resets when it changes. */
  scope: string;
  load: (args: {
    status: Status | "";
    cursor: string | null;
  }) => Promise<{ items: RunView[]; nextCursor: string | null }>;
  cancel?: (key: string) => Promise<void>;
  emptyHint: string;
};

type State = {
  scope: string;
  status: Status | "";
  items: RunView[];
  cursors: Array<string | null>;
  nextCursor: string | null;
  error: string | null;
};

const store = createStore<State>(() => ({
  scope: "",
  status: "",
  items: [],
  cursors: [null],
  nextCursor: null,
  error: null,
}));

let source: RunsSource | undefined;

async function refresh(): Promise<void> {
  const { scope, status, cursors } = store.getState();
  if (!scope || !source) return;
  try {
    const pages = [];
    for (const cursor of cursors) pages.push(await source.load({ status, cursor }));
    store.setState({
      items: pages.flatMap((p) => p.items),
      nextCursor: pages.at(-1)?.nextCursor ?? null,
      error: null,
    });
  } catch (err) {
    store.setState({ error: asApiError(err).message });
  }
}

export function RunsTable({ source: from }: { source: RunsSource }) {
  source = from;
  if (store.getState().scope !== from.scope) {
    store.setState({ scope: from.scope, items: [], cursors: [null], nextCursor: null });
  }
  const state = useStoreBridge(store);
  usePolling(() => void refresh(), 2000);

  const setStatus = (status: Status | ""): void => {
    store.setState({ status, cursors: [null], items: [] });
    void refresh();
  };

  const cancel = async (key: string): Promise<void> => {
    try {
      await from.cancel?.(key);
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
            <tr key={run.key}>
              <td>
                {run.taskName}
                <div className="mono muted">{run.key.slice(0, 12)}</div>
              </td>
              <td>
                <span className={`status status-${run.status}`}>{run.status}</span>
              </td>
              <td>{run.attempt}</td>
              <td className="mono muted">{run.startedAt?.toLocaleTimeString() ?? "—"}</td>
              <td className="mono muted">{run.endedAt?.toLocaleTimeString() ?? "—"}</td>
              <td className="muted">{run.error ?? ""}</td>
              <td>
                {run.triggerHref ? (
                  <Link className="mono" href={run.triggerHref}>
                    trigger
                  </Link>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                {from.cancel && run.cancellable ? (
                  <button onClick={() => void cancel(run.key)}>Cancel</button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {state.items.length === 0 ? <p className="muted">{from.emptyHint}</p> : null}
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

/** The owner's runs: real ids, real error text, and a cancel button. */
export function WorkflowRuns({ workflowId }: { workflowId: string }) {
  return (
    <RunsTable
      source={{
        scope: `workflow:${workflowId}`,
        emptyHint: "No runs yet. Trigger a node from the graph.",
        async load({ status, cursor }) {
          const page = await api.run.list.query({
            workflowId,
            ...(status ? { status } : {}),
            ...(cursor ? { cursor } : {}),
            limit: 25,
          });
          return {
            nextCursor: page.nextCursor,
            items: page.items.map((run) => ({
              key: run.id,
              taskName: run.taskName,
              status: run.status,
              attempt: run.attempt,
              startedAt: run.startedAt,
              endedAt: run.endedAt,
              error: run.error,
              triggerHref: run.triggerEventId
                ? `/workflows/${workflowId}/events?event=${run.triggerEventId}`
                : null,
              cancellable: run.status === "queued" || run.status === "running",
            })),
          };
        },
        cancel: async (runId) => {
          await api.run.cancel.mutate({ runId });
        },
      }}
    />
  );
}

/**
 * A viewer's runs: opaque refs, an error *class* rather than a message, and no cancel —
 * a share confers reads only. The status filter is client-visible but the server never
 * receives it, because the public list model does not take one; filtering here would page
 * inconsistently, so the public source ignores it and shows everything.
 */
export function SharedRuns({ token }: { token: string }) {
  return (
    <RunsTable
      source={{
        scope: `share:${token}`,
        emptyHint: "This workflow has not run yet.",
        async load({ cursor }) {
          const page = await api.public.runs.query({
            token,
            ...(cursor ? { cursor } : {}),
            limit: 25,
          });
          return {
            nextCursor: page.nextCursor,
            items: page.items.map((run) => ({
              key: run.ref,
              taskName: run.taskName,
              status: run.status,
              attempt: run.attempt,
              startedAt: run.startedAt,
              endedAt: run.endedAt,
              error: run.errorClass,
              triggerHref: `/s/${encodeURIComponent(token)}/runs/${encodeURIComponent(run.ref)}`,
              cancellable: false,
            })),
          };
        },
      }}
    />
  );
}
