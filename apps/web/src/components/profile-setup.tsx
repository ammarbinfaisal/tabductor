"use client";
import { api, asApiError } from "../lib/api.js";
import { createStore } from "zustand/vanilla";
import { useStoreBridge } from "../lib/store.js";
const store = createStore<{ busy: boolean; error: string | null }>(() => ({ busy: false, error: null }));
export function ProfileSetup({ workflowId }: { workflowId: string }) {
  const state = useStoreBridge(store);
  async function setup() {
    if (store.getState().busy) return;
    store.setState({ busy: true, error: null });
    try { const session = await api.browserSession.setupProfile.mutate({ workflowId }); window.location.assign(`/sessions/${session.sessionId}`); }
    catch (error) { store.setState({ busy: false, error: asApiError(error).message }); }
  }
  return <div>
    <p>Set up the selected profile, or create one automatically for this workflow.</p>
    {state.error ? <p role="alert">{state.error}</p> : null}<button disabled={state.busy} onClick={() => void setup()}>{state.busy ? "Opening browser…" : "Set up browser profile"}</button></div>;
}
