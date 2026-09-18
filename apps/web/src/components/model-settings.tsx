"use client";

import { createStore } from "zustand/vanilla";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";

const state = createStore<{ busy: boolean; error: string | null }>(() => ({ busy: false, error: null }));
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
    <p>{workflowId ? "Override the account model for this workflow." : "Choose the model used for authoring, execution, recovery, and compilation."} Your own key is billed by its provider. Tabductor models use prepaid credits.</p>
    <p>Current selection: <strong>{current ? `${current.model} · ${current.funding === "byo" ? "your key" : "Tabductor credits"}` : workflowId ? "Account default" : "Not configured"}</strong></p>
    {error ? <p role="alert">{error}</p> : null}
    <form className="stack" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget);
      const credential = settings.credentials.find((entry) => entry.id === data.get("credential"));
      if (!credential) return;
      void act(() => api.account.setModel.mutate({ scope, funding: "byo", provider: credential.provider, credentialId: credential.id, model: String(data.get("model")) }));
    }}>
      <h3>Use your own key</h3>
      <label>Credential <select name="credential" required disabled={busy || settings.credentials.length === 0}>
        {settings.credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label} · {credential.provider}</option>)}
      </select></label>
      <label>Provider model ID <input name="model" required maxLength={200} defaultValue={current?.funding === "byo" ? current.model : ""} autoComplete="off" /></label>
      <button disabled={busy || settings.credentials.length === 0}>Use this model</button>
    </form>
    {settings.platformModels.length ? <form className="stack" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget);
      const selected = settings.platformModels[Number(data.get("model"))]; if (!selected) return;
      void act(() => api.account.setModel.mutate({ scope, funding: "platform", provider: selected.provider, model: selected.model }));
    }}>
      <h3>Use Tabductor credits</h3>
      <label>Model <select name="model">{settings.platformModels.map((model, index) => <option key={`${model.provider}:${model.model}`} value={index}>
        {model.model} · {model.input.toLocaleString()} input / {model.output.toLocaleString()} output credits per million tokens
      </option>)}</select></label>
      <button disabled={busy}>Use Tabductor model</button>
    </form> : <p className="muted">Tabductor models are not configured on this installation.</p>}
    {!workflowId ? <>
      <h2>Provider credentials</h2>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
        void act(async () => { await api.account.saveModelCredential.mutate({ provider: data.get("provider") === "anthropic" ? "anthropic" : "openai", label: String(data.get("label")), apiKey: String(data.get("key")) }); form.reset(); });
      }}>
        <label>Provider <select name="provider"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
        <label>Label <input name="label" required maxLength={120} /></label>
        <label>API key <input name="key" type="password" required maxLength={4096} autoComplete="off" spellCheck={false} /></label>
        <button disabled={busy}>Save encrypted key</button>
      </form>
      <ul>{settings.credentials.map((credential) => <li key={credential.id}>{credential.label} · {credential.provider} <button disabled={busy} onClick={() => void act(() => api.account.revokeModelCredential.mutate({ id: credential.id }))}>Revoke</button></li>)}</ul>
    </> : null}
  </section>;
}
