"use client";
import Link from "next/link";
import { createStore } from "zustand/vanilla";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";
import { ProfileSetup } from "./profile-setup.js";

const state = createStore<{ busy: boolean; error: string | null; code: string | null }>(() => ({ busy: false, error: null, code: null }));
async function act(action: () => Promise<void>) {
  if (state.getState().busy) return;
  state.setState({ busy: true, error: null });
  try { await action(); } catch (error) { state.setState({ error: asApiError(error).message }); }
  finally { state.setState({ busy: false }); }
}
export function BrowserProfiles({ profiles, workflowId, selectedProfileId, allowSetup = false }: { profiles: RouterOutputs["browserSession"]["profiles"]; workflowId?: string; selectedProfileId?: string; allowSetup?: boolean }) {
  const view = useStoreBridge(state);
  return <section className="settings-section" id="browser-profiles" aria-label="Browser profiles">
    {workflowId ? <h2>Browser profiles</h2> : null}
    <p>Create a persistent browser profile, then open it to visit websites and sign in. Stop the session when finished to save cookies and browser storage for future runs.</p>
    {workflowId && allowSetup ? <ProfileSetup key={workflowId} workflowId={workflowId} /> : null}
    <p><a href="/profile-extension.zip" download>Download the Chrome extension</a>. Unzip it, open chrome://extensions, enable Developer mode, and choose Load unpacked.</p>
    {view.error ? <p role="alert">{view.error}</p> : null}
    <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void act(async () => { await api.browserSession.createProfile.mutate({ name: String(data.get("name")) }); location.reload(); }); }}>
      <label>Profile name<input name="name" required maxLength={120} placeholder="My work browser" /></label>
      <button disabled={view.busy}>Create profile</button>
    </form>
    {workflowId ? <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void act(async () => { await api.browserSession.bindProfile.mutate({ workflowId, profileId: String(data.get("profile")) }); location.reload(); }); }}>
      <label>Profile for this workflow<select name="profile" defaultValue={selectedProfileId ?? ""} required><option value="" disabled>Select a profile</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      <button disabled={view.busy || !profiles.length}>Use profile for future browser sessions</button>
    </form> : null}
    <div className="ruled">{profiles.map(profile => <section key={profile.id}>
      <h3>{profile.name}{profile.id === selectedProfileId ? " · Used by this workflow" : ""}</h3><p className="muted">{profile.saved ? "Saved browser state available" : "Ready for setup"}</p>
      <button disabled={view.busy} onClick={() => void act(async () => { const result = await api.browserSession.openProfile.mutate({ profileId: profile.id }); location.assign(`/sessions/${result.sessionId}`); })}>Open browser & sign in</button>
      <details><summary>Import login from browser extension</summary>
        <p>Open the signed-in website in Chrome, then use the Tabductor extension to import that site’s cookies and complete local storage. Each code is for this profile and one website, expires after five minutes, and works once.</p>
        <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void act(async () => {
          const grant = await api.browserSession.importCode.mutate({ profileId: profile.id, origin: String(data.get("origin")) });
          state.setState({ code: JSON.stringify({ ...grant, server: location.origin }) });
        }); }}><label>Website address<input name="origin" type="url" required placeholder="https://x.com" /></label><button disabled={view.busy}>Create import code</button></form>
      </details>
    </section>)}</div>
    {view.code ? <section aria-label="Extension import code"><h2>Extension import code</h2><p>Paste this code into the extension while the selected website is open.</p>
      <textarea aria-label="Import code" readOnly value={view.code} spellCheck={false} /><button onClick={() => void act(async () => { await navigator.clipboard.writeText(view.code!); })}>Copy code</button><button className="btn--quiet" onClick={() => state.setState({ code: null })}>Hide code</button></section> : null}
    <p><Link href="/sessions">View browser sessions ↗</Link></p>
  </section>;
}
