"use client";

import { createStore } from "zustand/vanilla";
import type { EventDetail, EventListItem } from "@tabductor/engine";
import { api, asApiError } from "../lib/api.js";
import { usePolling, useStoreBridge } from "../lib/store.js";

/**
 * The event feed (U0): every event the workflow produced, newest first, with a type filter
 * and a cursor. Selecting one opens its causation chain — the breadcrumb from the trigger
 * that started everything down to this event — and the runs it created.
 *
 * Lineage comes from `event.get`, which is the bus's own recursive walk. The UI does not
 * reconstruct chains from the list it happens to have loaded.
 */
type State = {
  workflowId: string;
  type: string;
  items: EventListItem[];
  types: string[];
  nextCursor: string | null;
  cursors: Array<string | null>;
  selected: EventDetail | null;
  error: string | null;
};

const store = createStore<State>(() => ({
  workflowId: "",
  type: "",
  items: [],
  types: [],
  nextCursor: null,
  cursors: [null],
  selected: null,
  error: null,
}));

async function refresh(): Promise<void> {
  const { workflowId, type, cursors } = store.getState();
  if (!workflowId) return;
  try {
    const pages = [];
    for (const cursor of cursors) {
      pages.push(
        await api.event.list.query({
          workflowId,
          ...(type ? { type } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 25,
        }),
      );
    }
    const items = pages.flatMap((p) => p.items);
    store.setState({
      items,
      nextCursor: pages.at(-1)?.nextCursor ?? null,
      // The filter's options are whatever has actually been seen — no catalogue of event
      // types exists, and inventing one would go stale the first time a node emits.
      types: [...new Set([...store.getState().types, ...items.map((e) => e.type)])].sort(),
      error: null,
    });
  } catch (err) {
    store.setState({ error: asApiError(err).message });
  }
}

async function open(eventId: string): Promise<void> {
  try {
    store.setState({ selected: await api.event.get.query({ eventId }), error: null });
  } catch (err) {
    store.setState({ error: asApiError(err).message });
  }
}

export function EventFeed({
  workflowId,
  initialEventId,
}: {
  workflowId: string;
  initialEventId: string | null;
}) {
  if (store.getState().workflowId !== workflowId) {
    store.setState({ workflowId, items: [], cursors: [null], nextCursor: null, selected: null });
    if (initialEventId) void open(initialEventId);
  }
  const state = useStoreBridge(store);
  usePolling(() => void refresh(), 2000);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Events</h1>
        <div className="row">
          <select
            value={state.type}
            onChange={(e) => {
              store.setState({ type: e.target.value, cursors: [null], items: [] });
              void refresh();
            }}
          >
            <option value="">all types</option>
            {state.types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <span className="muted">{state.items.length} shown · refreshing every 2s</span>
        </div>
      </div>

      {state.error ? <div className="banner banner-error">{state.error}</div> : null}
      {state.selected ? <Lineage detail={state.selected} workflowId={workflowId} /> : null}

      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Source</th>
            <th>At</th>
            <th>Packet</th>
            <th>Event id</th>
          </tr>
        </thead>
        <tbody>
          {state.items.map((event) => (
            <tr key={event.eventId} onClick={() => void open(event.eventId)} style={{ cursor: "pointer" }}>
              <td>
                <code>{event.type}</code>
              </td>
              <td>{event.sourceTaskName ?? <span className="muted">system</span>}</td>
              <td className="mono muted">{event.occurredAt.toLocaleTimeString()}</td>
              <td className="mono muted packet">{JSON.stringify(event.packet)}</td>
              <td className="mono muted">{event.eventId.slice(0, 8)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {state.items.length === 0 ? <p className="muted">No events yet.</p> : null}
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

function Lineage({ detail, workflowId }: { detail: EventDetail; workflowId: string }) {
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          <code>{detail.event.type}</code>{" "}
          <span className="mono muted">{detail.event.eventId}</span>
        </h2>
        <button onClick={() => store.setState({ selected: null })}>Close</button>
      </div>

      <p className="row" style={{ gap: 4 }}>
        {detail.lineage.map((e, i) => (
          <span key={e.eventId} className="row" style={{ gap: 4 }}>
            {i > 0 ? <span className="muted">→</span> : null}
            <button className="crumb" onClick={() => void open(e.eventId)}>
              {e.type}
            </button>
          </span>
        ))}
      </p>

      <pre className="mono">{JSON.stringify(detail.event.packet, null, 2)}</pre>

      {detail.triggered.length > 0 ? (
        <p className="muted">
          triggered{" "}
          {detail.triggered.map((r) => (
            <span key={r.id}>
              <a href={`/workflows/${workflowId}/runs`}>{r.taskName}</a>{" "}
              <span className={`status status-${r.status}`}>{r.status}</span>{" "}
            </span>
          ))}
        </p>
      ) : (
        <p className="muted">No run was created from this event.</p>
      )}
    </div>
  );
}
