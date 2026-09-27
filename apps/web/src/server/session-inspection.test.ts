import { describe, expect, it, vi } from "vitest";
import type { BrowserSessionActivityRow, Db, TraceEntryRow } from "@tabductor/db";
import { inspectionAction, inspectionActivity, inspectSession, resolveRunSessions, sanitizeInspectionData } from "./session-inspection.js";
const run = { id: "run-a", taskId: "runtime-a", taskName: "Research", triggerEventId: "trigger-a" };
const at = new Date("2026-01-01T00:00:00Z");
const trace = (payloadJson: unknown, kind: TraceEntryRow["kind"] = "action"): TraceEntryRow => ({ runId: run.id, seq: 7, kind, payloadJson, blobRef: null, createdAt: at });
describe("session event projection", () => {
  it("uses runtime authority and summary labels without inventing a recording offset", () => {
    expect(inspectionAction(trace({ action: "tool.call", tool: "browser.python", callId: "call-a", ok: false, runId: "spoof" }), run,
      { status: "ready", label: "extract", summary: "Read product prices" })).toMatchObject({ runId: run.id, label: "extract", description: "Read product prices", status: "failed", offsetMs: null });
  });
  it("shows the code explanation beside the tool call independently of execution status", () => {
    const summary = { status: "ready", label: "extract", summary: "Reads page text and prints it" };
    for (const ok of [true, false]) {
      expect(inspectionAction(trace({ action: "tool.call", tool: "browser.python", callId: "call-a", ok }), run, summary))
        .toMatchObject({ description: summary.summary, label: "extract", status: ok ? "succeeded" : "failed", summaryStatus: "ready" });
    }
  });
  it("uses deterministic screenshot and navigation titles", () => {
    expect(inspectionAction(trace({ action: "tool.call", tool: "browser.screenshot" }), run)?.description).toBe("Screenshot");
    expect(inspectionAction(trace({}, "navigation"), run)?.description).toBe("Navigation");
  });
  it("shows safe model usage without exposing generated thoughts", () => {
    expect(inspectionAction(trace({ usage: { in: 1200, out: 85 }, text: "PRIVATE" }, "llm"), run)?.description)
      .toBe("Model update · 1,200 input / 85 output tokens");
  });
  it("never exposes source, arguments, URLs, errors or hidden reasoning", () => {
    const projected = inspectionAction(trace({ action: "tool.call", tool: "browser.python", code: "PRIVATE", args: "PRIVATE", error: "PRIVATE", thought: "PRIVATE", response: "PRIVATE" }), run);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE");
    expect(inspectionAction(trace({ action: "tool.call", private: true }), run)).toBeNull();
    expect(inspectionAction(trace({ action: "tool.call", evidenceOmitted: true }), run)).toBeNull();
    expect(inspectionAction(trace({ action: "sdk.operation" }), run)).toBeNull();
    expect(inspectionAction(trace({ action: "tool.call", tool: "browser.events" }), run)).toBeNull();
    expect(JSON.stringify(sanitizeInspectionData({ token: "PRIVATE", reasoning: "PRIVATE" }))).not.toContain("PRIVATE");
  });
  it("uses only explicit worker clock offsets", () => {
    const row = { cursor: 1, sessionId: "s", kind: "page.goto", pageId: null, private: false, offsetMs: 2400, createdAt: at, payloadJson: { commandId: "c", clock: "recorder", callId: "call-a" } } as BrowserSessionActivityRow;
    expect(inspectionActivity(row, run)).toMatchObject({ offsetMs: 2400, callId: "call-a", label: "navigation" });
    expect(inspectionActivity({ ...row, payloadJson: {} }, run)?.offsetMs).toBeNull();
    expect(inspectionActivity({ ...row, private: true }, run)).toBeNull();
  });
  it("links to the latest proven replacement session and does not use unrelated leases", () => {
    const command = (id: string) => ({ id, runId: run.id, status: "ended" as const });
    expect(resolveRunSessions([command("first"), command("replacement")], [command("unrelated")]).get(run.id)).toMatchObject({ id: "replacement", sessionCount: 2, sessionHref: "/sessions/replacement" });
  });
  it("rejects foreign sessions before querying execution evidence", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
    await expect(inspectSession({ select } as unknown as Db, "owner", "foreign")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(select).toHaveBeenCalledTimes(1);
  });
});
