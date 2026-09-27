"use client";

import { createStore } from "zustand/vanilla";
import Link from "next/link";
import { api, asApiError } from "../../lib/api.js";
import { parseResultSchemaText } from "../../lib/result-schema.js";
import { useStoreBridge } from "../../lib/store.js";

type State = { prompt: string; profileId: string; resultSchemaText: string; busy: boolean; error: string | null };
const store = createStore<State>(() => ({ prompt: "", profileId: "", resultSchemaText: "", busy: false, error: null }));

/** Select the browser profile before saving the directing prompt and output contract. */
export function CreateWorkflow({ profiles }: { profiles: { id: string; name: string }[] }) {
  const state = useStoreBridge(store);
  const selectedProfile = profiles.find(profile => profile.id === state.profileId);
  const create = async () => {
    const prompt = state.prompt;
    if (!prompt.trim() || !selectedProfile || state.busy) return;
    store.setState({ busy: true, error: null });
    try {
      const resultSchema = parseResultSchemaText(state.resultSchemaText);
      const created = await api.workflow.createFromPrompt.mutate({ prompt, resultSchema, profileId: selectedProfile.id });
      store.setState({ prompt: "", profileId: "", resultSchemaText: "", busy: false });
      window.location.assign(`/workflows/${created.workflowId}`);
    } catch (err) { store.setState({ busy: false, error: asApiError(err).message }); }
  };

  return <form className="workflow-create stack" onSubmit={(event) => { event.preventDefault(); void create(); }}>
    <label className="field"><span>What should your browser do?</span>
      <textarea value={state.prompt} maxLength={20000} disabled={state.busy}
        placeholder="Describe the whole workflow: what to do, where to do it, any constraints, and the result to return."
        onChange={(event) => store.setState({ prompt: event.target.value })} /></label>
    <div className="stack">
      <label className="field"><span>Browser profile</span>
        <select value={selectedProfile?.id ?? ""} required disabled={state.busy || !profiles.length}
          aria-describedby="workflow-profile-help" onChange={(event) => store.setState({ profileId: event.target.value })}>
          <option value="" disabled>Select an existing profile</option>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>
      <p className="muted" id="workflow-profile-help">{profiles.length
        ? <>This workflow will use the selected profile’s saved logins and browser state. <Link href="/profiles">Manage profiles</Link></>
        : <>Create a browser profile first, then return here to select it. <Link href="/profiles">Create a profile</Link></>}</p>
    </div>
    <details className="advanced-options"><summary>Define a result schema <span className="muted">Optional</span></summary>
    <label className="field"><span>Result schema (JSON Schema draft-07)</span>
      <textarea className="mono" rows={5} value={state.resultSchemaText} disabled={state.busy}
        placeholder={'{ "type": "object", "properties": { "summary": { "type": "string" } }, "required": ["summary"] }'}
        onChange={(event) => store.setState({ resultSchemaText: event.target.value })} /></label></details>
    {state.error ? <p className="banner banner--error" role="alert">{state.error}</p> : null}
    <div className="composer-footer"><p className="muted">Describe the outcome. Make it repeatable.</p><button className="btn--primary" type="submit" disabled={state.busy || !state.prompt.trim() || !selectedProfile}>
      {state.busy ? "Creating workflow…" : "Create workflow →"}
    </button></div>
  </form>;
}
