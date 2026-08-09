"use client";

import { createStore } from "zustand/vanilla";
import { api, asApiError } from "../../lib/api.js";
import { useStoreBridge } from "../../lib/store.js";

type State = { name: string; busy: boolean; error: string | null };

const store = createStore<State>(() => ({ name: "", busy: false, error: null }));

/** The whole create flow: a name, a button, and one mutation. */
export function CreateWorkflow() {
  const state = useStoreBridge(store);

  const create = async () => {
    const name = state.name.trim();
    if (!name || state.busy) return;
    store.setState({ busy: true, error: null });
    try {
      const id = await api.workflow.create.mutate({ name });
      store.setState({ name: "", busy: false });
      // `useRouter` is a hook, and the policy has no exemption for navigation. A full load
      // of the new workflow is the honest cost of that rule here.
      window.location.assign(`/workflows/${id}`);
    } catch (err) {
      store.setState({ busy: false, error: asApiError(err).message });
    }
  };

  return (
    <div className="row">
      {state.error ? <span className="muted">{state.error}</span> : null}
      <input
        placeholder="new workflow name"
        value={state.name}
        onChange={(e) => store.setState({ name: e.target.value })}
        onKeyDown={(e) => (e.key === "Enter" ? void create() : undefined)}
      />
      <button onClick={() => void create()} disabled={state.busy || !state.name.trim()}>
        Create
      </button>
    </div>
  );
}
