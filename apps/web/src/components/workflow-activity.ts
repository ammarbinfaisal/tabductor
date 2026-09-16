"use client";

import { createStore } from "zustand/vanilla";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";

export type ActivityEvent = RouterOutputs["event"]["list"]["items"][number];
export type ActivityRun = RouterOutputs["run"]["list"]["items"][number];
type ActivityState = {
  events: ActivityEvent[];
  runs: ActivityRun[];
  packet: RouterOutputs["event"]["get"] | null;
  packetKey: string | null;
  packetLoading: boolean;
  error: string | null;
  loading: boolean;
  tab: "packets" | "runs";
  eventCursor: string | null;
  runCursor: string | null;
  zoom: number;
};

export function createActivityStore(workflowId: string, versionId: string | null) {
  const store = createStore<ActivityState>(() => ({ events: [], runs: [], packet: null, packetKey: null, packetLoading: false, error: null, loading: true, tab: "packets", eventCursor: null, runCursor: null, zoom: 1 }));
  let fetching = false;
  let pageRequest = false;
  const scope = { workflowId, ...(versionId ? { versionId } : {}) };
  return {
    ...store,
    async refresh() {
      if (fetching || pageRequest) return;
      if (!versionId) { store.setState({ loading: false }); return; }
      fetching = true;
      try {
        const packetKey = store.getState().packetKey;
        const [events, runs, packet] = await Promise.all([
          api.event.list.query({ ...scope, limit: 100 }),
          api.run.list.query({ ...scope, limit: 100 }),
          packetKey ? api.event.get.query({ eventId: packetKey }) : Promise.resolve(null),
        ]);
        // Replace the live window while retaining explicitly paged older records.
        const previous = store.getState();
        const merge = <T>(fresh: T[], prior: T[], key: (item: T) => string): T[] => {
          const ids = new Set(fresh.map(key));
          return [...fresh, ...prior.filter((item) => !ids.has(key(item)))];
        };
        store.setState({
          events: merge(events.items, previous.events, (e) => e.eventId),
          runs: merge(runs.items, previous.runs, (r) => r.id),
          eventCursor: previous.events.length ? previous.eventCursor : events.nextCursor,
          runCursor: previous.runs.length ? previous.runCursor : runs.nextCursor,
          ...(packetKey === store.getState().packetKey && packet ? { packet } : {}),
          loading: false, error: null,
        });
      } catch (err) { store.setState({ loading: false, error: asApiError(err).message }); }
      finally { fetching = false; }
    },
    async more() {
      if (pageRequest || fetching) return;
      const state = store.getState();
      const cursor = state.tab === "packets" ? state.eventCursor : state.runCursor;
      if (!cursor) return;
      pageRequest = true;
      store.setState({ loading: true });
      try {
        if (state.tab === "packets") {
          const page = await api.event.list.query({ ...scope, limit: 100, cursor });
          const ids = new Set(state.events.map((e) => e.eventId));
          store.setState({ events: [...state.events, ...page.items.filter((e) => !ids.has(e.eventId))], eventCursor: page.nextCursor });
        } else {
          const page = await api.run.list.query({ ...scope, limit: 100, cursor });
          const ids = new Set(state.runs.map((r) => r.id));
          store.setState({ runs: [...state.runs, ...page.items.filter((r) => !ids.has(r.id))], runCursor: page.nextCursor });
        }
      } catch (err) { store.setState({ error: asApiError(err).message }); }
      finally { pageRequest = false; store.setState({ loading: false }); }
    },
    async openPacket(eventId: string) {
      store.setState({ packetKey: eventId, packet: null, packetLoading: true });
      try {
        const packet = await api.event.get.query({ eventId });
        if (store.getState().packetKey === eventId) store.setState({ packet, packetLoading: false, error: null });
      } catch (err) {
        if (store.getState().packetKey === eventId) store.setState({ packetLoading: false, error: asApiError(err).message });
      }
    },
    closePacket() { store.setState({ packetKey: null, packet: null, packetLoading: false }); },
    setTab(tab: ActivityState["tab"]) { store.setState({ tab }); },
    zoom(delta: number) { store.setState({ zoom: Math.max(0.35, Math.min(1.5, store.getState().zoom + delta)) }); },
    fit(width: number, graphWidth: number) { store.setState({ zoom: Math.max(0.2, Math.min(1, width / graphWidth)) }); },
  };
}

export type ActivityStore = ReturnType<typeof createActivityStore>;
const stores = new Map<string, ActivityStore>();
export function activityFor(workflowId: string, versionId: string | null): ActivityStore {
  const key = `${workflowId}:${versionId}`;
  let store = stores.get(key);
  if (!store) { store = createActivityStore(workflowId, versionId); stores.set(key, store); }
  return store;
}
