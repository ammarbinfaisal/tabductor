"use client";
import Link from "next/link";
import { createStore } from "zustand/vanilla";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";
import { useMountHook } from "../lib/use-mount-hook.js";
import { attachRemotePaste } from "../lib/remote-paste.js";

type Playback = RouterOutputs["browserSession"]["get"];
type Tabs = RouterOutputs["browserSession"]["tabs"];
type Activity = RouterOutputs["browserSession"]["activity"];
const state = createStore<{ data: Playback | null; activity: Activity; tabs: Tabs; tabsError: string | null; selectingTab: string | null; error: string | null; connected: boolean }>(() => ({ data: null, activity: [], tabs: [], tabsError: null, selectingTab: null, error: null, connected: false }));
let disconnect: (() => void) | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let currentId = "";
let connectionAttempt = 0;
let connecting = false;
let desiredAccess: "view" | "control" = "view";
let retryAfter = 0;

async function refreshTabs(id: string) {
  try {
    const tabs = await api.browserSession.tabs.query({ sessionId: id });
    if (currentId === id) state.setState({ tabs, tabsError: null });
  } catch (error) {
    if (currentId === id) state.setState({ tabsError: asApiError(error).message });
  }
}
async function selectTab(id: string, pageId: string) {
  state.setState({ selectingTab: pageId });
  try {
    await api.browserSession.selectTab.mutate({ sessionId: id, pageId });
    await refreshTabs(id);
  } catch (error) { report(error); }
  finally { if (currentId === id) state.setState({ selectingTab: null }); }
}
async function refresh(id: string) {
  const cursor = state.getState().activity.at(-1)?.cursor ?? 0;
  const [data, activity] = await Promise.all([api.browserSession.get.query({ sessionId: id }), api.browserSession.activity.query({ sessionId: id, after: cursor, limit: 200 })]);
  if (currentId !== id) return;
  state.setState((old) => ({ data, activity: [...old.activity, ...activity] }));
  const active = ["ready", "running"].includes(data.session.status);
  if (!active) {
    disconnect?.(); disconnect = undefined;
    return;
  }
  const setup = data.session.executionId === null;
  if (setup) desiredAccess = "control";
  if (!disconnect && !connecting && Date.now() >= retryAfter &&
    (desiredAccess === "view" || data.session.inputOwner === "human")) await connect(id, desiredAccess);
}
async function connect(id: string, access: "view" | "control") {
  const attempt = ++connectionAttempt;
  connecting = true;
  desiredAccess = access;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  disconnect?.(); disconnect = undefined;
  state.setState({ connected: false });
  try {
  const { token, expiresAt, inputGeneration } = await api.browserSession.viewerToken.mutate({ sessionId: id, access });
  const { default: RFB } = await import("@novnc/novnc/lib/rfb.js");
  if (currentId !== id || attempt !== connectionAttempt) return;
  const target = document.getElementById("session-viewer");
  if (!target) return;
  const url = new URL("/browser-gateway/live", window.location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const client = new RFB(target, url.toString(), { wsProtocols: [`td.${token}`] });
  client.viewOnly = access === "view";
  client.scaleViewport = true;
  const detachPaste = access === "control" ? attachRemotePaste(target, {
    enabled: () => attempt === connectionAttempt && state.getState().connected && state.getState().data?.session.inputOwner === "human",
    paste: text => api.browserSession.paste.mutate({ sessionId: id, inputGeneration, text }),
    report,
  }) : () => {};
  disconnect = () => { detachPaste(); client.disconnect(); };
  client.addEventListener("connect", () => {
    if (attempt === connectionAttempt) state.setState({ connected: true, error: null });
  });
  client.addEventListener("disconnect", () => {
    detachPaste();
    if (attempt !== connectionAttempt) return;
    disconnect = undefined;
    retryAfter = Date.now() + 1000;
    state.setState({ connected: false });
  });
  if (access === "view") reconnectTimer = setTimeout(() => { void connect(id, "view").catch(report); }, Math.max(1000, expiresAt - Date.now() - 5000));
  } catch (error) {
    if (attempt === connectionAttempt) retryAfter = Date.now() + 3000;
    throw error;
  } finally {
    if (attempt === connectionAttempt) connecting = false;
  }
}
function report(error: unknown) { state.setState({ error: asApiError(error).message }); }
async function action(id: string, kind: "takeover" | "resume" | "stop") {
  try {
    if (kind === "takeover") {
      await api.browserSession.requestTakeover.mutate({ sessionId: id });
      for (let n = 0; n < 60; n++) {
        await refresh(id);
        if (state.getState().data?.session.inputOwner === "human") { await connect(id, "control"); return; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Waiting for the browser to acknowledge takeover. Refresh its status before trying again.");
    }
    disconnect?.();
    if (kind === "resume") { await api.browserSession.resume.mutate({ sessionId: id }); await connect(id, "view"); }
    else await api.browserSession.stop.mutate({ sessionId: id });
    await refresh(id);
  } catch (error) { report(error); }
}
export function SessionInspector({ sessionId }: { sessionId: string }) {
  const view = useStoreBridge(state);
  useMountHook(() => {
    currentId = sessionId;
    desiredAccess = "view";
    retryAfter = 0;
    connecting = false;
    state.setState({ data: null, activity: [], tabs: [], tabsError: null, selectingTab: null, error: null, connected: false });
    let disposed = false, polling = false;
    const poll = () => { if (polling || disposed) return; polling = true; void refresh(sessionId).catch(report).finally(() => { polling = false; }); };
    poll();
    const timer = setInterval(poll, 1000);
    let tabsPolling = false;
    const pollTabs = () => {
      if (disposed || tabsPolling) return;
      tabsPolling = true;
      void refreshTabs(sessionId).finally(() => { tabsPolling = false; });
    };
    pollTabs();
    const tabsTimer = setInterval(pollTabs, 2000);
    return () => { disposed = true; currentId = ""; connectionAttempt++; clearInterval(timer); clearInterval(tabsTimer); if (reconnectTimer) clearTimeout(reconnectTimer); disconnect?.(); disconnect = undefined; };
  });
  const session = view.data?.session;
  const active = session && ["ready", "running"].includes(session.status);
  const setup = session?.executionId === null;
  const resuming = session?.inputOwner === "ai" && session.automationAcknowledgedGeneration !== session.inputOwnerGeneration;
  return <>
    <p>Status: <strong>{session?.status ?? "Loading…"}</strong> · input: {resuming ? "Resuming…" : session?.inputOwner ?? "—"}</p>
    {resuming ? <p role="status">Waiting for the browser to acknowledge automation control.</p> : null}
    {session?.status === "stopping" ? <p role="status">Saving profile… Wait for this to finish before reopening it. Any queued session using this profile will start after the save completes.</p> : null}
    {session?.error ? <p role="alert">This session ended with an error ({session.error}). Its latest profile changes may not have been saved.</p> : null}
    {session?.status === "ended" && !session.error && session.readyAt ? <p role="status">Profile saved. You can reopen it from Profiles.</p> : null}
    {session?.status === "queued" ? <p role="status">{view.data?.waitingForSessionId ? <>
      This profile is open in another browser. <Link href={`/sessions/${view.data.waitingForSessionId}`}>Open that browser</Link> to watch it or finish signing in, then stop it to save the profile and let this session start.
    </> : "Waiting for a browser to become available. Live viewing will be available when this session is ready."}</p> : null}
    {view.error ? <p role="alert">{view.error}</p> : null}
    {active ? <p role="status">{view.connected ? setup ? "You have control. Sign in and update your profile, then stop the session to save it." : "Live browser connected." : setup ? "Connecting your profile browser…" : "Connecting live view…"}</p> : null}
    <div className="row session-controls">
      {!setup ? <>
      <button disabled={!active} onClick={() => void connect(sessionId, "view").catch(report)}>Watch live</button>
      <button disabled={!active || session.inputOwner === "human"} onClick={() => void action(sessionId, "takeover")}>Take control</button>
      <button disabled={!active || session.inputOwner === "ai"} onClick={() => void action(sessionId, "resume")}>Resume automation</button>
      </> : null}
      <button disabled={!session || ["ended", "failed", "stopping"].includes(session.status)} onClick={() => void action(sessionId, "stop")}>Stop session & save profile</button>
    </div>
    <form className="browser-address" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void api.browserSession.navigate.mutate({ sessionId, url: String(data.get("url")) }).catch(report); }}>
      <label>Website address<input name="url" type="url" required placeholder="https://x.com" disabled={!active || session.inputOwner !== "human"} /></label>
      <button disabled={!active || session.inputOwner !== "human"}>Go</button>
    </form>
    {setup ? <p className="muted">Profile setup stays under your control until you stop the session. Sign-in activity is private in recordings.</p> : <>
      <p>Choose Take control to navigate and sign in. When finished, resume automation.</p>
      <p className="muted">Taking control makes the rest of this session private in recordings. Disconnecting control pauses input; resume explicitly when you are finished.</p>
    </>}
    {active ? <section className="browser-tabs" aria-label="Browser tabs">
      <h2>Tabs <span className="muted">({view.tabs.length})</span></h2>
      <p className="muted">Choose a tab to watch. Tasks take turns on shared tabs and work in parallel on different tabs.</p>
      {view.tabsError ? <p role="status">{view.tabsError}</p> : null}
      {!view.tabsError && !view.tabs.length ? <p role="status">Waiting for browser tabs…</p> : null}
      <div className="browser-tab-list">{view.tabs.map(tab => <button type="button" key={tab.pageId}
        className="browser-tab" aria-pressed={tab.selected} disabled={view.selectingTab !== null}
        onClick={() => void selectTab(sessionId, tab.pageId)}>
        <span className="browser-tab-title">{tab.title || "New tab"}</span>
        <span className="browser-tab-url" title={tab.url}>{tab.url}</span>
        <span className="muted">{view.selectingTab === tab.pageId ? "Selecting…" : tab.selected ? "Viewing · " : ""}
          {tab.taskName ? `${tab.taskName} · ${tab.runId ? "Working" : "Available"}` : "Browser tab"}</span>
      </button>)}</div>
    </section> : null}
    <div id="session-viewer" className="session-viewer" aria-label="Live browser" />
    {active && view.connected && desiredAccess === "control" && session.inputOwner === "human" ? <p className="muted">Click inside the browser, then use Ctrl+V or ⌘V to paste text from your clipboard.</p> : null}
    <h2>Playback</h2>
    <PlaybackVideo sessionId={sessionId} />
    <h2>Activity</h2><ol className="session-timeline">{view.activity.map((item) => <li key={item.cursor}>
      <button onClick={() => { const video = document.getElementById("session-playback") as HTMLVideoElement | null; if (video) video.currentTime = item.offsetMs / 1000; }}>
        {(item.offsetMs / 1000).toFixed(1)}s · {item.kind}{item.private ? " · private" : ""}
      </button>
    </li>)}</ol>
    {view.data?.segments.some((segment) => segment.status !== "ready") ? <p className="muted">Private intervals and recording gaps are unavailable for playback.</p> : null}
  </>;
}
function PlaybackVideo({ sessionId }: { sessionId: string }) {
  useMountHook(() => {
    const video = document.getElementById("session-playback") as HTMLVideoElement | null;
    if (!video) return;
    const src = `/api/browser-sessions/${encodeURIComponent(sessionId)}/media/index.m3u8`;
    let disposed = false;
    let destroy: (() => void) | undefined;
    if (video.canPlayType("application/vnd.apple.mpegurl")) video.src = src;
    else void import("hls.js").then(({ default: Hls }) => {
      if (disposed || !Hls.isSupported()) return;
      const hls = new Hls(); hls.loadSource(src); hls.attachMedia(video); destroy = () => hls.destroy();
    });
    return () => { disposed = true; destroy?.(); };
  });
  return <video id="session-playback" controls playsInline preload="none" aria-label="Session recording" style={{ width: "100%", maxHeight: "60vh" }} />;
}
