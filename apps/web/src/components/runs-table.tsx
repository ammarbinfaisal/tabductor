"use client";

import type { RunStatus } from "@tabductor/engine";
import Link from "next/link";
import { api, type RouterOutputs } from "../lib/api.js";
import { createPagedStore, pagedStoreFor, type PagedStore } from "../lib/paged-store.js";
import { usePolling, useStoreBridge } from "../lib/store.js";

/**
 * The runs table (U0), parameterized by where its rows come from (U0.5).
 *
 * There is one implementation because there is one table: the owner's view and a share
 * viewer's differ only in which procedure loads a page and whether a run can be cancelled.
 * Two copies would drift, and the copy nobody is looking at is the public one.
 *
 * Paging, polling and error handling come from `createPagedStore`, which the event feed
 * uses too. What is left here is the columns and the two adapters.
 */

/**
 * The statuses the filter offers.
 *
 * `Record<RunStatus, …>` rather than a list, because a record is exhaustive: a status added
 * to the engine becomes a compile error here instead of an option nobody notices is missing.
 * And the type is imported, never the value — `@tabductor/engine` reaches drizzle and `pg`,
 * so a value import from a client component would drag Postgres into the browser bundle.
 */
const STATUS_OPTIONS: Record<RunStatus, true> = {
  queued: true,
  running: true,
  succeeded: true,
  failed: true,
  timed_out: true,
  cancelled: true,
};

/** One row, after each side has adapted its own shape to the one the table renders. */
export type RunView = {
  /** Row identity: a real id for the owner, a share-scoped ref for a viewer. */
  key: string;
  taskName: string;
  status: RunStatus;
  attempt: number;
  startedAt: Date | null;
  endedAt: Date | null;
  /** The owner's error message, or a viewer's bounded error class. One column either way. */
  error: string | null;
  triggerHref: string | null;
  cancellable: boolean;
};

export type RunsSource = {
  /** Identity of the scope: one store per workflow or share token. */
  scope: string;
  load: (args: {
    status: RunStatus | "";
    cursor: string | null;
  }) => Promise<{ items: RunView[]; nextCursor: string | null }>;
  cancel?: (key: string) => Promise<void>;
  emptyHint: string;
};

type Filter = { status: RunStatus | "" };
type RunsStore = PagedStore<RunView, Filter>;

const storeFor = (source: RunsSource): RunsStore =>
  pagedStoreFor("runs", source.scope, () =>
    createPagedStore<RunView, Filter>({
      extra: { status: "" },
      load: ({ status, cursor }) => source.load({ status, cursor }),
    }),
  );

export function RunsTable({ source }: { source: RunsSource }) {
  const store = storeFor(source);
  const state = useStoreBridge(store);
  usePolling(() => void store.refresh(), 2000);

  const cancel = async (key: string): Promise<void> => {
    try {
      await source.cancel?.(key);
    } catch (err) {
      store.fail(err);
    }
    await store.refresh();
  };

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Runs</h1>
        <div className="row">
          <select
            value={state.status}
            onChange={(e) => store.narrow({ status: e.target.value as RunStatus | "" })}
          >
            <option value="">all statuses</option>
            {Object.keys(STATUS_OPTIONS).map((s) => (
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
                {source.cancel && run.cancellable ? (
                  <button onClick={() => void cancel(run.key)}>Cancel</button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {state.items.length === 0 ? <p className="muted">{source.emptyHint}</p> : null}
      {state.nextCursor ? <button onClick={() => store.more()}>Load more</button> : null}
    </>
  );
}

/** The owner's runs: real ids, real error text, and a cancel button. */
export function WorkflowRuns({ workflowId }: { workflowId: string }) {
  const row = (run: RouterOutputs["run"]["list"]["items"][number]): RunView => ({
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
  });

  return (
    <RunsTable
      source={{
        scope: `workflow:${workflowId}`,
        emptyHint: "No runs yet. Trigger a node from the graph.",
        async load({ status, cursor }) {
          const page = await api.run.list.query({
            workflowId,
            status: status || undefined,
            cursor,
            limit: 25,
          });
          return { nextCursor: page.nextCursor, items: page.items.map(row) };
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
  const row = (run: RouterOutputs["public"]["runs"]["items"][number]): RunView => ({
    key: run.ref,
    taskName: run.taskName,
    status: run.status,
    attempt: run.attempt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    error: run.errorClass,
    triggerHref: `/s/${encodeURIComponent(token)}/runs/${encodeURIComponent(run.ref)}`,
    cancellable: false,
  });

  return (
    <RunsTable
      source={{
        scope: `share:${token}`,
        emptyHint: "This workflow has not run yet.",
        async load({ cursor }) {
          const page = await api.public.runs.query({ token, cursor, limit: 25 });
          return { nextCursor: page.nextCursor, items: page.items.map(row) };
        },
      }}
    />
  );
}
