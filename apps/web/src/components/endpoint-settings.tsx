"use client";

import { createStore } from "zustand/vanilla";
import type { RouterOutputs } from "../lib/api.js";
import { api, asApiError } from "../lib/api.js";
import { relativeTime } from "../lib/relative-time.js";
import { useStoreBridge } from "../lib/store.js";

/**
 * A workflow's "Browser endpoints" setting (U3a): the ordered list of CDP endpoints its
 * browser runs rotate across. The URL is write-only — the API never returns it (Threat 5) —
 * so rows are identified by label and id prefix, and an edit submits a replacement URL
 * blind rather than pre-filling the old one.
 *
 * Editing is in place, keeping the row's id and position: the list order *is* the rotation
 * order, so fixing a typo by remove-and-re-add would quietly move that browser to the back
 * of the queue.
 */

type Endpoints = RouterOutputs["endpoint"]["listForWorkflow"];

type State = {
  workflowId: string;
  endpoints: Endpoints;
  wsUrl: string;
  label: string;
  /** Endpoint id being edited, or null. Its URL is not pre-filled — we cannot read it back. */
  editingId: string | null;
  editUrl: string;
  editLabel: string;
  busy: boolean;
  error: string | null;
};

const store = createStore<State>(() => ({
  workflowId: "",
  endpoints: [],
  wsUrl: "",
  label: "",
  editingId: null,
  editUrl: "",
  editLabel: "",
  busy: false,
  error: null,
}));

async function load(): Promise<void> {
  const { workflowId } = store.getState();
  if (!workflowId) return;
  try {
    store.setState({ endpoints: await api.endpoint.listForWorkflow.query({ workflowId }), error: null });
  } catch (err) {
    store.setState({ error: asApiError(err).message });
  }
}

async function act(fn: () => Promise<void>): Promise<void> {
  store.setState({ busy: true, error: null });
  try {
    await fn();
    store.setState({ busy: false });
  } catch (err) {
    store.setState({ busy: false, error: asApiError(err).message });
  }
  await load();
}

function move(ids: string[], id: string, delta: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const next = [...ids];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function EndpointSettings({ workflowId }: { workflowId: string }) {
  if (store.getState().workflowId !== workflowId) {
    store.setState({
      workflowId,
      endpoints: [],
      wsUrl: "",
      label: "",
      editingId: null,
      editUrl: "",
      editLabel: "",
      error: null,
    });
    void load();
  }
  const state = useStoreBridge(store);
  const ids = state.endpoints.map((e) => e.id);

  return (
    <section>
      <h3>Browser endpoints</h3>
      <p className="muted">
        The browsers this workflow&apos;s browser nodes drive, in rotation: each run takes the one
        used longest ago, and two runs never share one at the same time. Start Chrome with{" "}
        <code>--remote-debugging-port</code> and paste its HTTP address —{" "}
        <code>http://127.0.0.1:9222</code>. The exact <code>ws://</code> URL is looked up on every
        connect, so a browser restart (which changes it) needs no edit here. The address is stored
        but never shown again.
      </p>

      {state.error ? <div className="banner banner-error">{state.error}</div> : null}

      {state.endpoints.length === 0 ? (
        <p className="muted">
          No endpoints yet — browser-node runs in <code>ai</code> or <code>compiled</code> mode will
          fail with <code>no_endpoint_configured</code> until one is added.
        </p>
      ) : (
        <div className="ruled">
          {state.endpoints.map((e, i) => (
            <div key={e.id}>
              <div className="row row--between">
              <span className="row">
                <span className={`status status-${e.healthy ? "succeeded" : "failed"}`}>
                  {e.healthy ? "healthy" : "unhealthy"}
                </span>
                <span>{e.label ?? "unlabelled"}</span>
                <span className="mono muted" style={{ fontSize: "var(--text-xs)" }}>
                  {e.id.slice(0, 12)}…
                </span>
              </span>
              <span className="row">
                <span className="mono muted" style={{ fontSize: "var(--text-xs)" }}>
                  {e.lastAcquiredAt ? `last run ${relativeTime(e.lastAcquiredAt)}` : "never used"}
                </span>
                <button
                  disabled={state.busy || i === 0}
                  title="Move up"
                  onClick={() => void act(async () => void (await api.endpoint.reorder.mutate({ workflowId, ids: move(ids, e.id, -1) })))}
                >
                  ↑
                </button>
                <button
                  disabled={state.busy || i === ids.length - 1}
                  title="Move down"
                  onClick={() => void act(async () => void (await api.endpoint.reorder.mutate({ workflowId, ids: move(ids, e.id, 1) })))}
                >
                  ↓
                </button>
                <button
                  disabled={state.busy}
                  onClick={() =>
                    store.setState(
                      state.editingId === e.id
                        ? { editingId: null, editUrl: "", editLabel: "" }
                        : { editingId: e.id, editUrl: "", editLabel: e.label ?? "" },
                    )
                  }
                >
                  {state.editingId === e.id ? "Cancel" : "Edit"}
                </button>
                <button
                  disabled={state.busy}
                  onClick={() => void act(async () => void (await api.endpoint.remove.mutate({ workflowId, id: e.id })))}
                >
                  Remove
                </button>
              </span>
              </div>
              {state.editingId === e.id ? (
                <div className="row" style={{ marginTop: "var(--space-1)" }}>
                  <label className="field" style={{ flex: 1 }}>
                    <span>New address</span>
                    <input
                      value={state.editUrl}
                      placeholder="http://127.0.0.1:9222"
                      onChange={(ev) => store.setState({ editUrl: ev.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Label</span>
                    <input
                      value={state.editLabel}
                      placeholder="my chrome"
                      onChange={(ev) => store.setState({ editLabel: ev.target.value })}
                    />
                  </label>
                  <button
                    disabled={state.busy || (!state.editUrl.trim() && state.editLabel === (e.label ?? ""))}
                    onClick={() =>
                      void act(async () => {
                        const { editUrl, editLabel } = store.getState();
                        await api.endpoint.update.mutate({
                          workflowId,
                          id: e.id,
                          // Left blank means "keep the address I cannot see"; only a typed
                          // value replaces it.
                          ...(editUrl.trim() ? { wsUrl: editUrl.trim() } : {}),
                          ...(editLabel === (e.label ?? "") ? {} : { label: editLabel.trim() }),
                        });
                        store.setState({ editingId: null, editUrl: "", editLabel: "" });
                      })
                    }
                  >
                    Save
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: "var(--space-2)" }}>
        <label className="field" style={{ flex: 1 }}>
          <span>Browser address</span>
          <input
            value={state.wsUrl}
            placeholder="http://127.0.0.1:9222"
            onChange={(e) => store.setState({ wsUrl: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Label</span>
          <input
            value={state.label}
            placeholder="my chrome"
            onChange={(e) => store.setState({ label: e.target.value })}
          />
        </label>
        <button
          disabled={state.busy || !state.wsUrl.trim()}
          onClick={() =>
            void act(async () => {
              await api.endpoint.add.mutate({
                workflowId,
                wsUrl: store.getState().wsUrl,
                ...(store.getState().label.trim() ? { label: store.getState().label.trim() } : {}),
              });
              store.setState({ wsUrl: "", label: "" });
            })
          }
        >
          Add endpoint
        </button>
      </div>
    </section>
  );
}
