"use client";

import { createStore } from "zustand/vanilla";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { usePolling, useStoreBridge } from "../lib/store.js";

const GRANT_KEYS = [
  "navigation",
  "action",
  "network.headers",
  "network.body",
  "secret.use",
  "secrets.read",
  "store.write",
] as const;
type GrantKey = (typeof GRANT_KEYS)[number];

type ApprovalState = {
  rows: RouterOutputs["policy"]["approvals"];
  loaded: boolean;
  busy: boolean;
  error: string | null;
};

const approvalStore = createStore<ApprovalState>(() => ({ rows: [], loaded: false, busy: false, error: null }));

async function loadApprovals(): Promise<void> {
  try {
    approvalStore.setState({ rows: await api.policy.approvals.query({ status: "pending" }), loaded: true, error: null });
  } catch (err) {
    approvalStore.setState({ loaded: true, error: asApiError(err).message });
  }
}

export function ApprovalsInbox() {
  if (!approvalStore.getState().loaded) {
    approvalStore.setState({ loaded: true });
    void loadApprovals();
  }
  const state = useStoreBridge(approvalStore);
  usePolling(() => void loadApprovals(), 2_000);

  const decide = async (approvalId: string, decision: "granted" | "denied"): Promise<void> => {
    approvalStore.setState({ busy: true, error: null });
    try {
      await api.policy.decideApproval.mutate({ approvalId, decision });
    } catch (err) {
      approvalStore.setState({ error: asApiError(err).message });
    }
    approvalStore.setState({ busy: false });
    await loadApprovals();
  };

  return (
    <>
      <h1>Approvals</h1>
      <p className="muted">Runs stay on the intercepted action while you decide. Expired requests fail closed.</p>
      {state.error ? <div className="banner banner--error">{state.error}</div> : null}
      {state.rows.length === 0 ? (
        <p className="muted">No runs are waiting for approval.</p>
      ) : (
        <div className="ruled">
          {state.rows.map((row) => (
            <section key={row.id} className="entity-card">
              <div className="row row--between">
                <span>
                  <code>{row.check}</code> · {row.rule}
                </span>
                <span className="mono muted">expires {row.expiresAt.toLocaleTimeString()}</span>
              </div>
              <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(row.requestJson, null, 2)}</pre>
              <div className="row">
                <button disabled={state.busy} onClick={() => void decide(row.id, "granted")}>Approve once</button>
                <button className="btn--destructive" disabled={state.busy} onClick={() => void decide(row.id, "denied")}>
                  Deny
                </button>
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

type BaselineState = {
  rows: RouterOutputs["policy"]["baseline"];
  effect: "deny" | "require_approval";
  key: GrantKey;
  value: string;
  loaded: boolean;
  busy: boolean;
  error: string | null;
};

const baselineStore = createStore<BaselineState>(() => ({
  rows: [],
  effect: "deny",
  key: "navigation",
  value: "",
  loaded: false,
  busy: false,
  error: null,
}));

async function loadBaseline(): Promise<void> {
  try {
    baselineStore.setState({ rows: await api.policy.baseline.query(), loaded: true, error: null });
  } catch (err) {
    baselineStore.setState({ loaded: true, error: asApiError(err).message });
  }
}

export function PolicySettings() {
  if (!baselineStore.getState().loaded) {
    baselineStore.setState({ loaded: true });
    void loadBaseline();
  }
  const state = useStoreBridge(baselineStore);
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    baselineStore.setState({ busy: true, error: null });
    try {
      await fn();
      baselineStore.setState({ busy: false, value: "" });
    } catch (err) {
      baselineStore.setState({ busy: false, error: asApiError(err).message });
    }
    await loadBaseline();
  };

  return (
    <>
      <h1>Policy baseline</h1>
      <p className="muted">These account-wide rules are checked first. A task grant cannot override a deny.</p>
      {state.error ? <div className="banner banner--error">{state.error}</div> : null}
      <div className="ruled">
        {state.rows.map((row) => (
          <div key={row.id} className="row row--between">
            <span><code>{row.rule.effect}</code> · {row.rule.grantKey} · <span className="mono">{row.rule.value}</span></span>
            <button disabled={state.busy} onClick={() => void act(() => api.policy.removeBaseline.mutate({ id: row.id }))}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: "var(--space-3)" }}>
        <select value={state.effect} onChange={(event) => baselineStore.setState({ effect: event.target.value as BaselineState["effect"] })}>
          <option value="deny">always deny</option>
          <option value="require_approval">always ask</option>
        </select>
        <select value={state.key} onChange={(event) => baselineStore.setState({ key: event.target.value as GrantKey })}>
          {GRANT_KEYS.map((key) => <option key={key}>{key}</option>)}
        </select>
        <input className="mono" value={state.value} placeholder="example.com or *" onChange={(event) => baselineStore.setState({ value: event.target.value })} />
        <button
          disabled={state.busy || !state.value.trim()}
          onClick={() => void act(() => api.policy.addBaseline.mutate({ effect: state.effect, grantKey: state.key, value: state.value.trim() }))}
        >
          Add rule
        </button>
      </div>
    </>
  );
}
