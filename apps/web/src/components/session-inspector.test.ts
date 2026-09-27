import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionInspector } from "./session-inspector.js";
import { useStoreBridge } from "../lib/store.js";
import { useMountHook } from "../lib/use-mount-hook.js";
import { api } from "../lib/api.js";

vi.mock("../lib/store.js", () => ({ useStoreBridge: vi.fn() }));
vi.mock("../lib/use-mount-hook.js", () => ({ useMountHook: vi.fn() }));
vi.mock("../lib/api.js", () => ({
  api: { browserSession: {
    get: { query: vi.fn() }, activity: { query: vi.fn(async () => []) },
    tabs: { query: vi.fn(async () => []) }, inspection: { query: vi.fn(async () => ({ items: [] })) },
  } },
  asApiError: (error: Error) => error,
}));

const playback = (profileSession: boolean, status: string) => ({
  session: { executionId: profileSession ? null : "execution", status, inputOwner: "human", recordingStatus: "complete", readyAt: new Date() },
  segments: [{ status: "ready", startMs: 0, endMs: 1000 }], name: "Work browser",
});
let data: ReturnType<typeof playback> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("React", { createElement, Fragment });
  data = null;
  vi.mocked(useStoreBridge).mockImplementation(store => {
    const snapshot = store.getState();
    return snapshot && typeof snapshot === "object" && "tabs" in snapshot ? Object.assign({}, snapshot, { data }) : snapshot;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const render = (profileSession: boolean) => renderToStaticMarkup(createElement(SessionInspector, { sessionId: "session", profileSession }));

describe("profile session browser", () => {
  it.each(["loading", "queued", "running", "stopping", "ended", "failed"])("hides workflow inspection and replay while %s", status => {
    data = status === "loading" ? null : playback(true, status);
    const html = render(true);
    expect(html).toContain("replay-layout--profile");
    expect(html).toContain('href="/profiles"');
    expect(html).toContain("Profile browser");
    for (const absent of ['aria-label="Session events"', 'aria-label="Recording event timeline"', 'aria-label="Workflow result"', 'aria-label="Session recording"', "0 events", "Resume automation", "No recording available"]) {
      expect(html).not.toContain(absent);
    }
    if (status === "running") {
      expect(html).toContain("You have control");
      expect(html).toContain("Website address");
      expect(html).toContain("Stop &amp; save profile");
    }
    if (status === "ended") expect(html).toContain("Profile saved");
  });

  it.each(["running", "ended"])("preserves workflow inspection during human control when %s", status => {
    data = playback(false, status);
    const html = render(false);
    expect(html).not.toContain("replay-layout--profile");
    expect(html).toContain('aria-label="Session events"');
    expect(html).toContain('aria-label="Recording event timeline"');
    expect(html).toContain('aria-label="Workflow result"');
    if (status === "running") expect(html).toContain("Resume automation");
    else expect(html).toContain('aria-label="Session recording"');
  });

  it.each([true, false])("polls inspection only for workflow sessions (profile session: %s)", async profileSession => {
    vi.mocked(api.browserSession.get.query).mockResolvedValue(playback(profileSession, "queued") as Awaited<ReturnType<typeof api.browserSession.get.query>>);
    render(profileSession);
    const cleanup = vi.mocked(useMountHook).mock.calls[0]![0]();
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(api.browserSession.get.query).toHaveBeenCalled();
      expect(api.browserSession.tabs.query).toHaveBeenCalled();
      if (profileSession) expect(api.browserSession.inspection.query).not.toHaveBeenCalled();
      else expect(api.browserSession.inspection.query).toHaveBeenCalled();
    } finally { cleanup?.(); }
  });
});
