"use client";

import { createStore, type StoreApi } from "zustand/vanilla";
import { api, asApiError } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";

type State = { name: string; draft: string; editing: boolean; busy: boolean; error: string | null };
const stores = new Map<string, StoreApi<State>>();

export function WorkflowName({ workflowId, name }: { workflowId: string; name: string }) {
  let store = stores.get(workflowId);
  if (!store) {
    store = createStore<State>(() => ({ name, draft: name, editing: false, busy: false, error: null }));
    stores.set(workflowId, store);
  }
  const s = store;
  const state = useStoreBridge(s);
  async function save() {
    s.setState({ busy: true, error: null });
    try {
      const updated = await api.workflow.rename.mutate({ workflowId, name: s.getState().draft });
      s.setState({ name: updated.name, draft: updated.name, editing: false });
    } catch (error) {
      s.setState({ error: asApiError(error).message });
    } finally {
      s.setState({ busy: false });
    }
  }
  return state.editing ? <form className="stack" onSubmit={event => { event.preventDefault(); void save(); }}>
    <label htmlFor={`workflow-name-${workflowId}`}>Workflow name</label>
    <div className="row">
      <input id={`workflow-name-${workflowId}`} value={state.draft} required maxLength={200} disabled={state.busy}
        onChange={event => s.setState({ draft: event.target.value })} />
      <button className="btn btn--primary" type="submit" disabled={state.busy || !state.draft.trim()}>{state.busy ? "Saving…" : "Save name"}</button>
      <button className="btn btn--quiet" type="button" disabled={state.busy}
        onClick={() => s.setState({ editing: false, draft: state.name, error: null })}>Cancel</button>
    </div>
    {state.error ? <p role="alert">{state.error}</p> : null}
  </form> : <span>
    <h1 style={{ display: "inline", marginLeft: "var(--space-2)" }}>{state.name}</h1>
    <button className="btn btn--quiet" type="button" aria-label="Rename workflow"
      onClick={() => s.setState({ editing: true, draft: state.name, error: null })}>Rename</button>
  </span>;
}
