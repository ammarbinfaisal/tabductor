"use client";

import { createStore } from "zustand/vanilla";
import { HealthStamp } from "./primitives.js";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { relativeTime } from "../lib/relative-time.js";
import { usePolling, useStoreBridge } from "../lib/store.js";

/**
 * The endpoint health panel (U1.5): `cdp_endpoints` has no per-workflow scope (one CDP
 * connection per user endpoint, §8), so this is one global page rather than a per-workflow
 * sidebar — see `docs/subphases/U1.5-run-inspector.md` for the placement argument. One
 * store, module-level: there is exactly one of this page per session, unlike the runs
 * table/event feed which need one store per workflow or share token.
 */

type EndpointRow = RouterOutputs["endpoint"]["list"][number];

type EndpointsState = { items: EndpointRow[]; error: string | null };

const store = createStore<EndpointsState>(() => ({ items: [], error: null }));

async function refresh(): Promise<void> {
  try {
    const items = await api.endpoint.list.query();
    store.setState({ items, error: null });
  } catch (err) {
    store.setState((state) => ({ ...state, error: asApiError(err).message }));
  }
}

export function EndpointHealth() {
  const state = useStoreBridge(store);
  usePolling(() => void refresh(), 2000);

  return (
    <>
      <h1 style={{ marginBottom: "var(--space-4)" }}>Endpoints</h1>

      {state.error ? (
        <div className="banner banner--error">The endpoint list didn&apos;t load. {state.error}</div>
      ) : null}

      <table className="ledger">
        <thead>
          <tr>
            <th>Label</th>
            <th>Health</th>
            <th>Last checked</th>
            <th>Queue depth</th>
          </tr>
        </thead>
        <tbody>
          {state.items.map((endpoint) => (
            <tr key={endpoint.id}>
              <td>
                {endpoint.label ?? <span className="muted">untitled</span>}
                <div className="mono muted">{endpoint.id.slice(0, 12)}</div>
              </td>
              <td>
                <HealthStamp healthy={endpoint.healthy} />
              </td>
              <td className="mono muted">
                {endpoint.lastCheckedAt ? relativeTime(endpoint.lastCheckedAt) : "never"}
              </td>
              <td className="mono muted">{endpoint.maxQueueDepth}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {state.items.length === 0 ? (
        <p className="muted">No CDP endpoints registered yet.</p>
      ) : null}
    </>
  );
}
