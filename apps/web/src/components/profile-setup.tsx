"use client";
import { api, asApiError } from "../lib/api.js";
import { createStore } from "zustand/vanilla";
import { useStoreBridge } from "../lib/store.js";
const store = createStore<{ busy: boolean; error: string | null }>(() => ({ busy: false, error: null }));
export function ProfileSetup({ workflowId }: { workflowId: string }) {
  const state = useStoreBridge(store);
  async function setup() {
    store.setState({ busy: true, error: null });
    try { const session = await api.browserSession.setupProfile.mutate({ workflowId }); window.location.assign(`/sessions/${session.sessionId}`); }
    catch (error) { store.setState({ busy: false, error: asApiError(error).message }); }
  }
  return <section><h2>Browser profile</h2><p>Open a managed browser to sign in. Stop the session when finished to save its profile for future runs.</p>
    {state.error ? <p role="alert">{state.error}</p> : null}<button disabled={state.busy} onClick={() => void setup()}>Set up browser profile</button></section>;
}
