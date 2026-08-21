import { expect, it } from "vitest";
import { checkConsistency, type RunTrace } from "@tabductor/compiler";

/**
 * The gate that decides whether a task is compilable at all.
 *
 * These traces are hand-written rather than harvested from a live run, and deliberately so:
 * the checker is a pure function over trace shapes, and constructing the exact divergence you
 * want to test is the only way to assert the *reason* rather than merely the verdict. The
 * shapes match what `packages/browser`'s `act()` actually records — `{action, selector}`,
 * `{action: "goto", url}`, `{action: "queryAll", selector, fields}`.
 */

let seq = 0;
const action = (payload: Record<string, unknown>) => ({ seq: seq++, kind: "action", payload: { ok: true, ...payload } });
const nav = (url: string) => ({ seq: seq++, kind: "navigation", payload: { url, cause: "initial" } });

function tweetsTrace(runId: string, opts: { selector?: string; extra?: boolean } = {}): RunTrace {
  seq = 0;
  const selector = opts.selector ?? "article";
  return {
    runId,
    entries: [
      nav("http://127.0.0.1/fake-tweets"),
      action({ action: "goto", url: "http://127.0.0.1/fake-tweets" }),
      action({ action: "waitFor", selector, timeout: 8000 }),
      action({ action: "queryAll", selector, fields: ["text", "url"] }),
      ...(opts.extra ? [action({ action: "scroll", direction: "down" })] : []),
      action({ action: "emit", type: "tweet.detected", dedupeKey: "/status/1" }),
      action({ action: "emit", type: "tweet.detected", dedupeKey: "/status/2" }),
    ],
  };
}

it("two runs that did the same thing are consistent, and the report describes the path", () => {
  const report = checkConsistency([tweetsTrace("run_a"), tweetsTrace("run_b")]);
  expect(report.consistent).toBe(true);
  if (!report.consistent) return;

  expect(report.anchors.map((a) => a.op)).toEqual(["goto", "waitFor", "queryAll"]);
  expect(report.extractions).toEqual([{ step: 2, selector: "article", fields: ["text", "url"] }]);
  expect(report.emits).toEqual(["tweet.detected"]);
  expect(report.navigations).toEqual(["http://127.0.0.1/fake-tweets"]);
  expect(report.fromRuns).toEqual(["run_a", "run_b"]);
  // The wait a guard should use is the largest one observed, never a tighter one.
  expect(report.waits[1]).toBe(8000);
});

it("the verdict does not depend on the order the traces were loaded in", () => {
  const a = tweetsTrace("run_a");
  const b = tweetsTrace("run_b", { selector: "article.tweet" });
  const forward = checkConsistency([a, b]);
  const backward = checkConsistency([b, a]);
  expect(forward).toEqual(backward);
  expect(forward.consistent).toBe(false);
});

it("a diverged locator is refused, and the reason names the step and both values", () => {
  const report = checkConsistency([tweetsTrace("run_a"), tweetsTrace("run_b", { selector: "article.tweet" })]);
  expect(report.consistent).toBe(false);
  if (report.consistent) return;
  expect(report.reason).toContain("step 2");
  expect(report.reason).toContain("article");
  expect(report.reason).toContain("article.tweet");
});

it("a diverged step count is refused", () => {
  const report = checkConsistency([tweetsTrace("run_a"), tweetsTrace("run_b", { extra: true })]);
  expect(report.consistent).toBe(false);
  if (report.consistent) return;
  expect(report.reason).toContain("step count diverged");
});

it("diverged emitted event types are refused even when every step matched", () => {
  const a = tweetsTrace("run_a");
  const b = tweetsTrace("run_b");
  b.entries = b.entries.map((e) =>
    e.payload.action === "emit" ? { ...e, payload: { ...e.payload, type: "something.else" } } : e,
  );
  const report = checkConsistency([a, b]);
  expect(report.consistent).toBe(false);
  if (report.consistent) return;
  expect(report.reason).toContain("emitted event types diverged");
});

it("one trace is never enough — K=2 is the threshold, not a suggestion", () => {
  const report = checkConsistency([tweetsTrace("run_a")]);
  expect(report.consistent).toBe(false);
  if (report.consistent) return;
  expect(report.reason).toContain("at least 2 traces");
});

/**
 * A failed action is the agent recovering, not the plan. Compiling the recovery attempt as if
 * it were the path is how a script learns to do the wrong thing reliably.
 */
it("failed actions are not part of the path", () => {
  const a = tweetsTrace("run_a");
  const b = tweetsTrace("run_b");
  b.entries.splice(2, 0, { seq: 1.5, kind: "action", payload: { action: "click", selector: "#gone", ok: false } });
  expect(checkConsistency([a, b]).consistent).toBe(true);
});
