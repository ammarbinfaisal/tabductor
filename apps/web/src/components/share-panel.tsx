"use client";

import { createStore } from "zustand/vanilla";
import type { RouterOutputs } from "../lib/api.js";
import { api, asApiError } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";

/**
 * Share management, owner side (U0.5).
 *
 * The link is shown **once**, at the moment it is issued, because only its hash is stored —
 * so this panel is the only place it will ever exist. That is stated on screen rather than
 * discovered later, and rotating is offered right beside it as the answer to losing one.
 */

type Preview = RouterOutputs["share"]["preview"];
type ShareList = RouterOutputs["share"]["list"];

type State = {
  workflowId: string;
  shares: ShareList;
  preview: Preview | null;
  /** The plaintext token, held in memory only until the page is left. */
  issued: { id: string; token: string } | null;
  busy: boolean;
  error: string | null;
};

const store = createStore<State>(() => ({
  workflowId: "",
  shares: [],
  preview: null,
  issued: null,
  busy: false,
  error: null,
}));

async function load(): Promise<void> {
  const { workflowId } = store.getState();
  if (!workflowId) return;
  try {
    store.setState({
      shares: await api.share.list.query({ workflowId }),
      preview: await api.share.preview.query({ workflowId }),
      error: null,
    });
  } catch (err) {
    store.setState({ error: asApiError(err).message });
  }
}

async function act(fn: () => Promise<{ id: string; token: string } | null>): Promise<void> {
  store.setState({ busy: true, error: null });
  try {
    const issued = await fn();
    store.setState({ busy: false, ...(issued ? { issued } : {}) });
  } catch (err) {
    store.setState({ busy: false, error: asApiError(err).message });
  }
  await load();
}

export function SharePanel({ workflowId }: { workflowId: string }) {
  if (store.getState().workflowId !== workflowId) {
    store.setState({ workflowId, shares: [], preview: null, issued: null, error: null });
    void load();
  }
  const state = useStoreBridge(store);
  const preview = state.preview;

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Sharing</h1>
        <button
          disabled={state.busy}
          onClick={() =>
            void act(async () => {
              const { share } = await api.share.create.mutate({ workflowId });
              return { id: share.id, token: share.token };
            })
          }
        >
          Create share link
        </button>
      </div>

      {state.error ? <div className="banner banner-error">{state.error}</div> : null}
      {state.issued ? <IssuedLink token={state.issued.token} /> : null}

      <section>
        <h3>What a viewer can read</h3>
        <p className="muted">
          The graph, its schedules, run statuses and timings, and the event timeline are visible to
          anyone holding a link. <strong>Packets are not</strong>, unless the emitting node marks that
          event type as shared. Run error messages are never shared — a viewer sees a category such as{" "}
          <code>timeout</code> instead. Marking an event shared is a change to the graph, so it takes
          effect when you publish a version.
        </p>
        {preview === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p className="mono muted">nodes: {preview.nodes.join(", ") || "none"}</p>
            {preview.publicEvents.length === 0 ? (
              <p className="muted">No event type is shared, so no packet is readable.</p>
            ) : (
              preview.publicEvents.map((e) => (
                <div className="emit" key={`${e.task}|${e.type}`}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <code>{e.type}</code>
                    <span className="muted">from {e.task}</span>
                  </div>
                  <div className="mono muted">
                    {e.fields.length > 0 ? `fields: ${e.fields.join(", ")}` : "schema declares no fields"}
                  </div>
                </div>
              ))
            )}
            {preview.privateEvents.length > 0 ? (
              <p className="mono muted">
                withheld: {preview.privateEvents.map((e) => e.type).join(", ")}
              </p>
            ) : null}
          </>
        )}
      </section>

      <section>
        <h3>Links</h3>
        {state.shares.length === 0 ? (
          <p className="muted">No share links yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Link</th>
                <th>Created</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.shares.map((share) => (
                <tr key={share.id}>
                  <td className="mono">{share.tokenPrefix}…</td>
                  <td className="mono muted">{share.createdAt.toLocaleString()}</td>
                  <td>{share.revokedAt ? <span className="muted">revoked</span> : "live"}</td>
                  <td>
                    {share.revokedAt ? null : (
                      <div className="row">
                        <button
                          disabled={state.busy}
                          onClick={() =>
                            void act(async () => {
                              const issued = await api.share.rotate.mutate({ shareId: share.id });
                              return { id: issued.id, token: issued.token };
                            })
                          }
                        >
                          Rotate
                        </button>
                        <button
                          disabled={state.busy}
                          onClick={() =>
                            void act(async () => {
                              await api.share.revoke.mutate({ shareId: share.id });
                              return null;
                            })
                          }
                        >
                          Revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function IssuedLink({ token }: { token: string }) {
  const url = `${typeof window === "undefined" ? "" : window.location.origin}/s/${encodeURIComponent(token)}`;
  return (
    <div className="banner">
      <p style={{ margin: 0 }}>
        <strong>Copy this now — it will not be shown again.</strong> Only a hash is stored, so nothing
        here or in the database can recover it. If you lose it, rotate the share for a new one.
      </p>
      <p className="mono packet" style={{ marginBottom: 0 }}>
        {url}
      </p>
      <button onClick={() => void navigator.clipboard?.writeText(url)}>Copy link</button>
    </div>
  );
}
