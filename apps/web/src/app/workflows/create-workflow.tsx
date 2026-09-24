"use client";

import { createStore } from "zustand/vanilla";
import { api, asApiError } from "../../lib/api.js";
import { parseResultSchemaText } from "../../lib/result-schema.js";
import { useStoreBridge } from "../../lib/store.js";

type State = { prompt: string; resultSchemaText: string; busy: boolean; error: string | null };
const store = createStore<State>(() => ({ prompt: "", resultSchemaText: "", busy: false, error: null }));

/** One directing prompt and an optional output contract are the entire starting input. */
export function CreateWorkflow() {
  const state = useStoreBridge(store);
  const create = async () => {
    const prompt = state.prompt.trim();
    if (!prompt || state.busy) return;
    store.setState({ busy: true, error: null });
    try {
      const resultSchema = parseResultSchemaText(state.resultSchemaText);
      const created = await api.workflow.createFromPrompt.mutate({ prompt, resultSchema });
      store.setState({ prompt: "", resultSchemaText: "", busy: false });
      window.location.assign(`/workflows/${created.workflowId}`);
    } catch (err) { store.setState({ busy: false, error: asApiError(err).message }); }
  };

  return <form className="workflow-create stack" onSubmit={(event) => { event.preventDefault(); void create(); }}>
    <label className="field"><span>What should your browser do?</span>
      <textarea value={state.prompt} maxLength={20000} disabled={state.busy}
        placeholder="Describe the whole workflow: what to do, where to do it, any constraints, and the result to return."
        onChange={(event) => store.setState({ prompt: event.target.value })} /></label>
    <details className="advanced-options"><summary>Define a result schema <span className="muted">Optional</span></summary>
    <label className="field"><span>Result schema (JSON Schema draft-07)</span>
      <textarea className="mono" rows={5} value={state.resultSchemaText} disabled={state.busy}
        placeholder={'{ "type": "object", "properties": { "summary": { "type": "string" } }, "required": ["summary"] }'}
        onChange={(event) => store.setState({ resultSchemaText: event.target.value })} /></label></details>
    {state.error ? <p className="banner banner--error" role="alert">{state.error}</p> : null}
    <div className="composer-footer"><p className="muted">Describe the outcome. Make it repeatable.</p><button className="btn--primary" type="submit" disabled={state.busy || !state.prompt.trim()}>
      {state.busy ? "Building workflow…" : "Create workflow →"}
    </button></div>
  </form>;
}
