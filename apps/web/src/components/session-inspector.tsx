"use client";
import { createStore } from "zustand/vanilla";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";
import { useMountHook } from "../lib/use-mount-hook.js";

type Playback = RouterOutputs["browserSession"]["get"];
type Activity = RouterOutputs["browserSession"]["activity"];
const state = createStore<{ data: Playback | null; activity: Activity; error: string | null; connected: boolean }>(() => ({ data: null, activity: [], error: null, connected: false }));
let disconnect: (() => void) | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let currentId = "";

async function refresh(id: string) {
  const cursor = state.getState().activity.at(-1)?.cursor ?? 0;
  const [data, activity] = await Promise.all([api.browserSession.get.query({ sessionId: id }), api.browserSession.activity.query({ sessionId: id, after: cursor, limit: 200 })]);
  if (currentId !== id) return;
  state.setState((old) => ({ data, activity: [...old.activity, ...activity], error: null }));
}
async function connect(id: string, access: "view" | "control") {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  disconnect?.(); disconnect = undefined;
  const { token, expiresAt } = await api.browserSession.viewerToken.mutate({ sessionId: id, access });
  const { default: RFB } = await import("@novnc/novnc/lib/rfb.js");
  if (currentId !== id) return;
  const target = document.getElementById("session-viewer");
  if (!target) return;
  const url = new URL("/browser-gateway/live", window.location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const client = new RFB(target, url.toString(), { wsProtocols: [`td.${token}`] });
  client.viewOnly = access === "view";
  client.scaleViewport = true;
  disconnect = () => client.disconnect();
  client.addEventListener("connect", () => state.setState({ connected: true }));
  client.addEventListener("disconnect", () => state.setState({ connected: false }));
  if (access === "view") reconnectTimer = setTimeout(() => { void connect(id, "view").catch(report); }, Math.max(1000, expiresAt - Date.now() - 5000));
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
    state.setState({ data: null, activity: [], error: null, connected: false });
    let disposed = false, polling = false;
    const poll = () => { if (polling || disposed) return; polling = true; void refresh(sessionId).catch(report).finally(() => { polling = false; }); };
    poll();
    const timer = setInterval(poll, 1000);
    return () => { disposed = true; currentId = ""; clearInterval(timer); if (reconnectTimer) clearTimeout(reconnectTimer); disconnect?.(); };
  });
  const session = view.data?.session;
  const active = session && ["ready", "running"].includes(session.status);
  return <>
    <p>Status: <strong>{session?.status ?? "Loading…"}</strong> · input: {session?.inputOwner ?? "—"}</p>
    {view.error ? <p role="alert">{view.error}</p> : null}
    <div className="row">
      <button disabled={!active} onClick={() => void connect(sessionId, "view").catch(report)}>Watch live</button>
      <button disabled={!active || session.inputOwner !== "ai"} onClick={() => void action(sessionId, "takeover")}>Take control</button>
      <button disabled={!active || session.inputOwner === "ai"} onClick={() => void action(sessionId, "resume")}>Resume automation</button>
      <button disabled={!active} onClick={() => void action(sessionId, "stop")}>Stop session</button>
    </div>
    <p className="muted">Taking control makes the rest of this session private in recordings. Disconnecting control pauses input; resume explicitly when you are finished.</p>
    <div id="session-viewer" className="session-viewer" aria-label="Live browser" />
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
