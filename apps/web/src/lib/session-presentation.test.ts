import { describe, expect, it } from "vitest";
import { sessionPresentation } from "./session-presentation.js";

describe("session media lifecycle", () => {
  it.each([undefined, "queued", "allocating", "ready", "running", "stopping"])("never exposes replay for %s, even when segments already exist", status => {
    expect(sessionPresentation(status, "partial", true).replay).toBe(false);
  });
  it.each(["ended", "failed"])("exposes retained recordings after %s", status => {
    expect(sessionPresentation(status, "partial", true)).toEqual({ active: false, stopped: true, replay: true });
  });
  it.each(["expired", "unavailable"])("does not mount unplayable %s recordings", recording => {
    expect(sessionPresentation("ended", recording, true).replay).toBe(false);
  });
  it("waits for a playable segment after stopping", () => {
    expect(sessionPresentation("ended", "complete", false).replay).toBe(false);
  });
  it.each(["ready", "running"])("keeps %s sessions live", status => {
    expect(sessionPresentation(status).active).toBe(true);
  });
});
