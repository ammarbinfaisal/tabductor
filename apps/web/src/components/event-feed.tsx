"use client";

import { api, type RouterOutputs } from "../lib/api.js";
import { createPagedStore, pagedStoreFor, type PagedStore } from "../lib/paged-store.js";
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
  /** Identity of the scope: one store per workflow or share token. */
  scope: string;
  load: (args: {
    type: string;
    cursor: string | null;
  }) => Promise<{ items: EventView[]; nextCursor: string | null }>;
  open: (key: string) => Promise<EventDetailView>;
  runsHref: string;
};

type Filter = {
  type: string;
  /**
   * The filter's options are whatever has actually been seen — no catalogue of event types
   * exists, and inventing one would go stale the first time a node emits.
   */
  types: string[];
  selected: EventDetailView | null;
};

type EventsStore = PagedStore<EventView, Filter>;

async function openInto(store: EventsStore, source: EventsSource, key: string): Promise<void> {
  try {
    const selected = await source.open(key);
    store.setState((state) => ({ ...state, selected, error: null }));
  } catch (err) {
    store.fail(err);
  }
}

const storeFor = (source: EventsSource, initialKey?: string | null): EventsStore =>
  pagedStoreFor("events", source.scope, () => {
    const store = createPagedStore<EventView, Filter>({
      extra: { type: "", types: [], selected: null },
      load: ({ type, cursor }) => source.load({ type, cursor }),
      onLoaded: (items, state) => ({
        types: [...new Set([...state.types, ...items.map((e) => e.type)])].sort(),
      }),
    });
    if (initialKey) void openInto(store, source, initialKey);
    return store;
  });

export function EventFeed({ source, initialKey }: { source: EventsSource; initialKey?: string | null }) {
  const store = storeFor(source, initialKey);
  const state = useStoreBridge(store);
  usePolling(() => void store.refresh(), 2000);

  const open = (key: string): void => void openInto(store, source, key);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Events</h1>
        <div className="row">
          <select value={state.type} onChange={(e) => store.narrow({ type: e.target.value })}>
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
      {state.selected ? (
        <Lineage
          detail={state.selected}
          runsHref={source.runsHref}
          onOpen={open}
          onClose={() => store.setState((s) => ({ ...s, selected: null }))}
        />
      ) : null}

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
            <tr key={event.key} onClick={() => open(event.key)} style={{ cursor: "pointer" }}>
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
      {state.nextCursor ? <button onClick={() => store.more()}>Load more</button> : null}
    </>
  );
}

/** Not `{}` — an empty object reads as "the packet was empty", which is a different claim. */
function NotShared() {
  return <em className="muted">packet not shared</em>;
}

function Lineage({
  detail,
  runsHref,
  onOpen,
  onClose,
}: {
  detail: EventDetailView;
  runsHref: string;
  onOpen: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          <code>{detail.event.type}</code>
        </h2>
        <button onClick={onClose}>Close</button>
      </div>

      <p className="row" style={{ gap: 4 }}>
        {detail.lineage.map((e, i) => (
          <span key={e.key} className="row" style={{ gap: 4 }}>
            {i > 0 ? <span className="muted">→</span> : null}
            <button className="crumb" onClick={() => onOpen(e.key)}>
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

/**
 * The owner's rows come from two procedures with slightly different shapes: `event.list`
 * joins the source task's name, `event.get` returns the bare row. The union says so, rather
 * than a hand-written type with an optional field that hides which one is which.
 */
type OwnerEventRow =
  | RouterOutputs["event"]["list"]["items"][number]
  | RouterOutputs["event"]["get"]["event"];

function ownerEvent(e: OwnerEventRow): EventView {
  return {
    key: e.eventId,
    type: e.type,
    sourceName: "sourceTaskName" in e ? e.sourceTaskName : null,
    occurredAt: e.occurredAt,
    packetShared: true,
    packet: e.packet,
  };
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
            type: type || undefined,
            cursor,
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

/** Both public procedures return the same event shape, so one adapter covers list and detail. */
type SharedEventRow = RouterOutputs["public"]["events"]["items"][number];

function sharedEvent(e: SharedEventRow): EventView {
  return {
    key: e.ref,
    type: e.type,
    sourceName: e.sourceTaskName,
    occurredAt: e.occurredAt,
    packetShared: e.packetPublic,
    packet: e.packet,
  };
}

/** A viewer's feed: opaque refs, and packets only for the types the author shared. */
export function SharedEvents({ token }: { token: string }) {
  return (
    <EventFeed
      source={{
        scope: `share:${token}`,
        runsHref: `/s/${encodeURIComponent(token)}/runs`,
        async load({ cursor }) {
          const page = await api.public.events.query({ token, cursor, limit: 25 });
          return { nextCursor: page.nextCursor, items: page.items.map(sharedEvent) };
        },
        async open(ref) {
          const detail = await api.public.event.query({ token, ref });
          return {
            event: sharedEvent(detail.event),
            lineage: detail.lineage.map(sharedEvent),
            triggered: detail.triggered.map((r) => ({ key: r.ref, taskName: r.taskName, status: r.status })),
          };
        },
      }}
    />
  );
}
