"use client";

import { createStore } from "zustand/vanilla";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";

const state = createStore<{ busy: boolean; error: string | null }>(() => ({ busy: false, error: null }));
const platformModelKey = (model: { provider: string; model: string }) => JSON.stringify([model.provider, model.model]);
async function act(action: () => Promise<unknown>) {
  if (state.getState().busy) return;
  state.setState({ busy: true, error: null });
  try { await action(); window.location.reload(); }
  catch (error) { state.setState({ busy: false, error: asApiError(error).message }); }
}

export function ModelSettings({ settings, workflowId }: { settings: RouterOutputs["account"]["modelSettings"]; workflowId?: string }) {
  const { busy, error } = useStoreBridge(state);
  const scope = workflowId ?? "account";
  const current = settings.selections.find((selection) => selection.scope === scope);
  return <section className="settings-section">
    <h2>{workflowId ? "Workflow model" : "Model source"}</h2>
    <p>AI usage is deducted from your prepaid balance using actual OpenAI costs. Displayed rates are estimates; provider charges may vary.</p>
    <p>Current selection: <strong>{current?.model ?? (workflowId ? "Account default" : "gpt-5.4")}</strong></p>
    {error ? <p role="alert">{error}</p> : null}
    {settings.platformModels.length ? <form className="stack" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget);
      const selected = settings.platformModels.find((candidate) => platformModelKey(candidate) === data.get("model")); if (!selected) return;
      void act(() => api.account.setModel.mutate({ scope, funding: "platform", provider: selected.provider, model: selected.model }));
    }}>
      <h3>Use Tabductor balance</h3>
      <label>Model <select name="model" defaultValue={platformModelKey(current ?? {provider:"openai",model:"gpt-5.4"})}>{settings.platformModels.map((model) => <option key={`${model.provider}:${model.model}`} value={platformModelKey(model)}>
        {model.model} · ${model.inputUsd} input / ${model.outputUsd} output USD per million tokens
      </option>)}</select></label>
      <button disabled={busy}>Use Tabductor model</button>
    </form> : <p className="muted">Tabductor models are not configured on this installation.</p>}
  </section>;
}
