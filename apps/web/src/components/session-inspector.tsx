"use client";
import Link from "next/link";
import { createStore } from "zustand/vanilla";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";
import { useMountHook } from "../lib/use-mount-hook.js";
import { Stamp } from "./primitives.js";
import { sessionPresentation } from "../lib/session-presentation.js";
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
  const { active } = sessionPresentation(data.session.status);
  if (!active) {
    connectionAttempt++;
    connecting = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    disconnect?.(); disconnect = undefined;
    state.setState({ connected: false });
    return;
  }
  const setup = data.session.executionId === null;
  if (setup) desiredAccess = "control";
  if (!disconnect && !connecting && Date.now() >= retryAfter &&
    (desiredAccess === "view" || data.session.inputOwner === "human")) await connect(id, desiredAccess);
}
async function connect(id: string, access: "view" | "control") {
  if (currentId !== id || !sessionPresentation(state.getState().data?.session.status).active) return;
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
    connectionAttempt++;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    disconnect?.(); disconnect = undefined;
    state.setState({ connected: false });
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
    const poll = () => { if (polling || disposed) return; polling = true; void refresh(sessionId).catch(error => { if (!disposed) report(error); }).finally(() => { polling = false; }); };
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
  const { active, stopped, replay } = sessionPresentation(session?.status, session?.recordingStatus, view.data?.segments.some(segment => segment.status === "ready"));
  const setup = session?.executionId === null;
  const resuming = session?.inputOwner === "ai" && session.automationAcknowledgedGeneration !== session.inputOwnerGeneration;
  return <section className="session-console" aria-label="Browser session">
    <div className="console-header">
      <div className="row"><span className="eyebrow">{stopped ? "Session replay" : "Live browser"}</span><Stamp kind={session?.status ?? "loading"} /></div>
      <span className="console-connection">{active ? view.connected ? "Connected" : "Connecting…" : stopped ? "Session stopped" : "Waiting for browser"}</span>
    </div>
    {view.error ? <div className="banner banner--error" role="alert">{view.error}</div> : null}
    {session?.error ? <div className="banner banner--error" role="alert">This session ended with an error ({session.error}). Its latest profile changes may not have been saved.</div> : null}
    {!stopped ? <>
      <div className="console-toolbar">
        <div className="row"><span className="muted">Control</span><strong>{resuming ? "Resuming…" : session?.inputOwner === "human" ? "You" : session?.inputOwner === "ai" ? "Automation" : "Paused"}</strong></div>
        <div className="row session-controls">
          {!setup ? <>
            {!view.connected ? <button disabled={!active} onClick={() => void connect(sessionId, "view").catch(report)}>Reconnect</button> : null}
            {session?.inputOwner === "human" ? <button className="btn--primary" disabled={!active} onClick={() => void action(sessionId, "resume")}>Resume automation</button>
              : <button disabled={!active || resuming} onClick={() => void action(sessionId, "takeover")}>Take control</button>}
          </> : null}
          <button className="btn--destructive" disabled={!session || session.status === "stopping"} onClick={() => void action(sessionId, "stop")}>Stop & save profile</button>
        </div>
      </div>
      {resuming ? <p className="console-note" role="status">Waiting for the browser to acknowledge automation control.</p> : null}
      {active && session?.inputOwner === "human" ? <form className="browser-address" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void api.browserSession.navigate.mutate({ sessionId, url: String(data.get("url")) }).catch(report); }}>
        <label><span className="sr-only">Website address</span><input name="url" type="url" required placeholder="Enter a website address…" /></label><button>Go →</button>
      </form> : null}
      {active ? <section className="browser-tabs" aria-label="Browser tabs">
        {view.tabsError ? <p className="console-note" role="status">{view.tabsError}</p> : null}
        {!view.tabsError && !view.tabs.length ? <p className="console-note" role="status">Waiting for browser tabs…</p> : null}
        <div className="browser-tab-list">{view.tabs.map(tab => <button type="button" key={tab.pageId}
          className="browser-tab" aria-pressed={tab.selected} disabled={view.selectingTab !== null}
          onClick={() => void selectTab(sessionId, tab.pageId)}>
          <span className="browser-tab-title">{tab.title || "New tab"}</span>
          <span className="browser-tab-url" title={tab.url}>{tab.url.length > 48 ? `${tab.url.slice(0, 47)}…` : tab.url}</span>
          <span className="browser-tab-meta">{view.selectingTab === tab.pageId ? "Selecting…" : tab.selected ? "Viewing" : "Open tab"}{tab.taskName ? ` · ${tab.taskName}` : ""}</span>
        </button>)}</div>
      </section> : null}
    </> : null}
    <div className="live-viewport" hidden={stopped}>
      <div id="session-viewer" className="session-viewer" aria-label="Live browser" />
      {!view.connected ? <div className="viewer-empty" role="status">
        <span className="viewer-glyph" aria-hidden="true">▣</span>
        <h2>{session?.status === "stopping" ? "Finishing your session" : active ? "Connecting to your browser" : "Your browser is getting ready"}</h2>
        <p>{session?.status === "stopping" ? "Saving your profile and finalizing the recording. Replay becomes available after the session stops."
          : view.data?.waitingForSessionId ? <>This profile is in use. <Link href={`/sessions/${view.data.waitingForSessionId}`}>Open its browser</Link> and stop it to let this session begin.</>
          : "This view connects automatically when the browser is ready."}</p>
      </div> : null}
    </div>
    {replay ? <div className="replay-surface"><PlaybackVideo key={sessionId} sessionId={sessionId} /><p className="console-note">Private intervals and recording gaps are unavailable for playback.</p></div>
      : stopped ? <div className="viewer-empty"><span className="viewer-glyph" aria-hidden="true">▣</span><h2>{session?.recordingStatus === "expired" ? "Recording expired" : "No recording available"}</h2><p>{session?.recordingStatus === "expired" ? "This session’s recording is no longer retained." : "This session has no playable recording. Private activity is excluded from replay."}</p></div> : null}
    {active ? <p className="console-note">{setup ? "You have control. Sign in, then stop the session to save your profile."
      : session?.inputOwner === "human" ? "You have control. Click inside the browser to type or paste. Resume automation when you’re ready."
      : "Watching live. Take control whenever you need to sign in or help the workflow."} <span className="muted">Human control makes the rest of the session private in recordings.</span></p> : null}
    {session?.status === "ended" && !session.error && session.readyAt ? <p className="console-note">Profile saved. <Link href="/profiles">Open profiles ↗︎</Link></p> : null}
    <details className="session-activity">
      <summary>Session activity <span className="muted">{view.activity.length} events</span></summary>
      {view.activity.length ? <ol className="session-timeline">{view.activity.map(item => <li key={item.cursor}>
        {replay && !item.private ? <button className="btn--quiet" onClick={() => { const video = document.getElementById("session-playback") as HTMLVideoElement | null; if (video) video.currentTime = item.offsetMs / 1000; }}>
          {(item.offsetMs / 1000).toFixed(1)}s · {item.kind}
        </button> : <span>{(item.offsetMs / 1000).toFixed(1)}s · {item.kind}{item.private ? " · private" : ""}</span>}
      </li>)}</ol> : <p className="muted">No activity recorded yet.</p>}
    </details>
  </section>;
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
    return () => { disposed = true; destroy?.(); video.removeAttribute("src"); video.load(); };
  });
  return <video id="session-playback" controls playsInline preload="none" aria-label="Session recording" style={{ width: "100%", maxHeight: "60vh" }} />;
}
