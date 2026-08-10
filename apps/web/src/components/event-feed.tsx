"use client";

import { createStore } from "zustand/vanilla";
import { api, asApiError } from "../lib/api.js";
import { usePolling, useStoreBridge } from "../lib/store.js";

/**
 * The event feed (U0), parameterized by where its rows come from (U0.5): every event the
 * workflow produced, newest first, with a type filter and a cursor. Selecting one opens its
 * causation chain — the breadcrumb from the trigger that started everything down to this
 * event — and the runs it created.
 *
 * Lineage comes from the server's own recursive walk. The UI does not reconstruct chains
 * from the list it happens to have loaded, on either side.
 *
 * The public side differs in exactly one visible way, and it is deliberate: an event whose
 * type the author did not share renders as *itself, without its packet*. Hiding the row
 * would misrepresent the timeline; hiding the packet is the whole feature.
 */

export type EventView = {
  /** Row identity: a real event id for the owner, a share-scoped ref for a viewer. */
  key: string;
  type: string;
  sourceName: string | null;
  occurredAt: Date;
  /** False only on the public side, and only for a type outside the manifest. */
  packetShared: boolean;
  packet: unknown;
};

export type EventDetailView = {
  event: EventView;
  lineage: EventView[];
  triggered: Array<{ key: string; taskName: string; status: string }>;
};

export type EventsSource = {
  scope: string;
  load: (args: {
    type: string;
    cursor: string | null;
  }) => Promise<{ items: EventView[]; nextCursor: string | null }>;
  open: (key: string) => Promise<EventDetailView>;
  runsHref: string;
};

type State = {
  scope: string;
  type: string;
  items: EventView[];
  types: string[];
  nextCursor: string | null;
  cursors: Array<string | null>;
  selected: EventDetailView | null;
  error: string | null;
};

const store = createStore<State>(() => ({
  scope: "",
  type: "",
  items: [],
  types: [],
  nextCursor: null,
  cursors: [null],
  selected: null,
  error: null,
}));

let source: EventsSource | undefined;

async function refresh(): Promise<void> {
  const { scope, type, cursors } = store.getState();
  if (!scope || !source) return;
  try {
    const pages = [];
    for (const cursor of cursors) pages.push(await source.load({ type, cursor }));
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

async function open(key: string): Promise<void> {
  if (!source) return;
  try {
    store.setState({ selected: await source.open(key), error: null });
  } catch (err) {
    store.setState({ error: asApiError(err).message });
  }
}

export function EventFeed({ source: from, initialKey }: { source: EventsSource; initialKey?: string | null }) {
  source = from;
  if (store.getState().scope !== from.scope) {
    store.setState({ scope: from.scope, items: [], cursors: [null], nextCursor: null, selected: null });
    if (initialKey) void open(initialKey);
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
      {state.selected ? <Lineage detail={state.selected} runsHref={from.runsHref} /> : null}

      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Source</th>
            <th>At</th>
            <th>Packet</th>
          </tr>
        </thead>
        <tbody>
          {state.items.map((event) => (
            <tr key={event.key} onClick={() => void open(event.key)} style={{ cursor: "pointer" }}>
              <td>
                <code>{event.type}</code>
              </td>
              <td>{event.sourceName ?? <span className="muted">system</span>}</td>
              <td className="mono muted">{event.occurredAt.toLocaleTimeString()}</td>
              <td className="mono muted packet">
                {event.packetShared ? JSON.stringify(event.packet) : <NotShared />}
              </td>
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

/** Not `{}` — an empty object reads as "the packet was empty", which is a different claim. */
function NotShared() {
  return <em className="muted">packet not shared</em>;
}

function Lineage({ detail, runsHref }: { detail: EventDetailView; runsHref: string }) {
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          <code>{detail.event.type}</code>
        </h2>
        <button onClick={() => store.setState({ selected: null })}>Close</button>
      </div>

      <p className="row" style={{ gap: 4 }}>
        {detail.lineage.map((e, i) => (
          <span key={e.key} className="row" style={{ gap: 4 }}>
            {i > 0 ? <span className="muted">→</span> : null}
            <button className="crumb" onClick={() => void open(e.key)}>
              {e.type}
            </button>
          </span>
        ))}
      </p>

      {detail.event.packetShared ? (
        <pre className="mono">{JSON.stringify(detail.event.packet, null, 2)}</pre>
      ) : (
        <p>
          <NotShared />
        </p>
      )}

      {detail.triggered.length > 0 ? (
        <p className="muted">
          triggered{" "}
          {detail.triggered.map((r) => (
            <span key={r.key}>
              <a href={runsHref}>{r.taskName}</a> <span className={`status status-${r.status}`}>{r.status}</span>{" "}
            </span>
          ))}
        </p>
      ) : (
        <p className="muted">No run was created from this event.</p>
      )}
    </div>
  );
}

/** The owner's feed: real ids, every packet, and a type filter the server honours. */
export function WorkflowEvents({
  workflowId,
  initialEventId,
}: {
  workflowId: string;
  initialEventId: string | null;
}) {
  return (
    <EventFeed
      initialKey={initialEventId}
      source={{
        scope: `workflow:${workflowId}`,
        runsHref: `/workflows/${workflowId}/runs`,
        async load({ type, cursor }) {
          const page = await api.event.list.query({
            workflowId,
            ...(type ? { type } : {}),
            ...(cursor ? { cursor } : {}),
            limit: 25,
          });
          return { nextCursor: page.nextCursor, items: page.items.map(ownerEvent) };
        },
        async open(eventId) {
          const detail = await api.event.get.query({ eventId });
          return {
            event: ownerEvent(detail.event),
            lineage: detail.lineage.map(ownerEvent),
            triggered: detail.triggered.map((r) => ({ key: r.id, taskName: r.taskName, status: r.status })),
          };
        },
      }}
    />
  );
}

function ownerEvent(e: {
  eventId: string;
  type: string;
  occurredAt: Date;
  packet: unknown;
  sourceTaskName?: string | null;
}): EventView {
  return {
    key: e.eventId,
    type: e.type,
    sourceName: e.sourceTaskName ?? null,
    occurredAt: e.occurredAt,
    packetShared: true,
    packet: e.packet,
  };
}

/** A viewer's feed: opaque refs, and packets only for the types the author shared. */
export function SharedEvents({ token }: { token: string }) {
  const shared = (e: {
    ref: string;
    type: string;
    sourceTaskName: string | null;
    occurredAt: Date;
    packetPublic: boolean;
    packet?: unknown;
  }): EventView => ({
    key: e.ref,
    type: e.type,
    sourceName: e.sourceTaskName,
    occurredAt: e.occurredAt,
    packetShared: e.packetPublic,
    packet: e.packet,
  });

  return (
    <EventFeed
      source={{
        scope: `share:${token}`,
        runsHref: `/s/${encodeURIComponent(token)}/runs`,
        async load({ cursor }) {
          const page = await api.public.events.query({ token, ...(cursor ? { cursor } : {}), limit: 25 });
          return { nextCursor: page.nextCursor, items: page.items.map(shared) };
        },
        async open(ref) {
          const detail = await api.public.event.query({ token, ref });
          return {
            event: shared(detail.event),
            lineage: detail.lineage.map(shared),
            triggered: detail.triggered.map((r) => ({ key: r.ref, taskName: r.taskName, status: r.status })),
          };
        },
      }}
    />
  );
}
