import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { AppError } from "@tabductor/core";
import { playwrightDriver, type NavigationRequest } from "@tabductor/browser";
import {
  openSession,
  payloadOf,
  startBrowserRig,
  waitForTrace,
  type BrowserRig,
  type Payload,
  type SessionRig,
} from "./browser-support.js";

/**
 * The guard's whole point is the navigations nobody called `goto` for. A wrapper around
 * `goto` passes the first test in this file and fails the other two, which is why the
 * implementation intercepts document requests on the context instead.
 */

const BLOCKED = "https://example.com/";

let rig: BrowserRig;
let sess: SessionRig | undefined;

beforeAll(async () => {
  rig = await startBrowserRig();
});

afterEach(async () => {
  await sess?.close();
  sess = undefined;
});

afterAll(async () => {
  await rig?.close();
});

const denials = (rows: { kind: string; payloadJson: unknown }[]): Payload[] =>
  rows.filter((r) => r.kind === "policy_denied").map((r) => r.payloadJson as Payload);

it("denies an off-allowlist goto, types the error, and leaves the page where it was", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  const before = page.url();

  const err = await page.goto(BLOCKED).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe("navigation_denied");
  expect((err as AppError).details).toMatchObject({ url: BLOCKED, cause: "initial" });

  expect(page.url()).toBe(before);

  const rows = await waitForTrace(rig, sess, "the denial", (r) => denials(r).length > 0);
  expect(denials(rows)[0]).toMatchObject({
    check: "navigation",
    url: BLOCKED,
    cause: "initial",
    rule: "harness_nav_allowlist",
  });
});

it("aborts a redirect mid-flight, after allowing the hop that caused it", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  const entry = `${rig.fx.url}/redirect?to=${encodeURIComponent(BLOCKED)}`;
  const err = await page.goto(entry).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).details).toMatchObject({ url: BLOCKED, cause: "redirect" });

  const rows = await waitForTrace(rig, sess, "the redirect denial", (r) => denials(r).length > 0);

  // Both halves are on the record: the allowed hop that was asked for, and the redirect it
  // turned into. A trace that showed only the denial would not explain how it got there.
  const navigated = rows.filter((r) => r.kind === "navigation").map(payloadOf);
  expect(navigated).toEqual([{ url: entry, cause: "initial" }]);
  expect(denials(rows)[0]).toMatchObject({ url: BLOCKED, cause: "redirect" });
  expect(page.url()).not.toContain("example.com");
});

it("guards a window.open the page script performed", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/popup?to=${encodeURIComponent(BLOCKED)}`);
  const opener = page.url();
  await page.click('[data-testid="open"]');

  // No error surfaces here — nobody awaited this navigation. The trace is the only place
  // it can show up, which is exactly why the guard records rather than only refusing.
  const rows = await waitForTrace(rig, sess, "the popup denial", (r) => denials(r).length > 0);
  expect(denials(rows)[0]).toMatchObject({
    check: "navigation",
    url: BLOCKED,
    cause: "window_open",
    rule: "harness_nav_allowlist",
  });
  expect(page.url()).toBe(opener);
});

it("guards a redirect that a popup walks into on its opening navigation", async () => {
  // The nastiest of the four, and the reason the guard is two layers: this navigation has no
  // page to attach a CDP session to *and* it redirects, so an allowlisted first hop carries
  // the popup somewhere else before anything of ours exists to object.
  sess = await openSession(rig);
  const { page } = sess.session;

  const hop = `${rig.fx.url}/redirect?to=${encodeURIComponent(BLOCKED)}`;
  await page.goto(`${rig.fx.url}/popup?to=${encodeURIComponent(hop)}`);
  await page.click('[data-testid="open"]');

  const rows = await waitForTrace(rig, sess, "the popup's redirect denial", (r) =>
    denials(r).some((d) => d.url === BLOCKED),
  );
  expect(rows.filter((r) => r.kind === "navigation").map(payloadOf)).toContainEqual({
    url: hop,
    cause: "window_open",
  });
  expect(denials(rows)).toContainEqual({
    check: "navigation",
    url: BLOCKED,
    cause: "redirect",
    rule: "harness_nav_allowlist",
  });
});

it("lets an allowed popup ride its redirect to the destination, every hop on the record", async () => {
  // The happy path of the stub-birth design: the popup is born holding an inert stub, gets
  // its guard, and only then re-issues the navigation — so the chain the trace shows is the
  // browser's real one, hop by hop, not a pre-flight probe's approximation of it.
  sess = await openSession(rig);
  const { page } = sess.session;

  const dest = `${rig.fx.url}/fake-tweets`;
  const hop = `${rig.fx.url}/redirect?to=${encodeURIComponent(dest)}`;
  await page.goto(`${rig.fx.url}/popup?to=${encodeURIComponent(hop)}`);
  await page.click('[data-testid="open"]');

  const rows = await waitForTrace(rig, sess, "the popup's full chain", (r) => {
    const navs = r.filter((x) => x.kind === "navigation").map(payloadOf);
    return (
      navs.some((n) => n.url === hop && n.cause === "window_open") &&
      navs.some((n) => n.url === dest && n.cause === "redirect")
    );
  });
  expect(denials(rows)).toEqual([]);
});

it("still guards a popup when two pages are open on one connection", async () => {
  // The popup-birth request cannot be attributed to a page when it happens; an earlier
  // draft resolved its hook only when exactly one page existed, so opening a second page
  // silently switched the popup guard off. Attribution now comes from `page.opener()` once
  // the stub has committed — so the popup answers to the page that opened it, and only that
  // one.
  const conn = await playwrightDriver.connect(rig.chrome.wsUrl);
  try {
    const seenByFirst: NavigationRequest[] = [];
    const seenBySecond: NavigationRequest[] = [];
    const hookInto = (seen: NavigationRequest[]) => async (req: NavigationRequest) => {
      seen.push(req);
      return req.url.startsWith(rig.fx.url);
    };
    const first = await conn.createPage({ onNavigationRequest: hookInto(seenByFirst) });
    const second = await conn.createPage({ onNavigationRequest: hookInto(seenBySecond) });
    await first.goto(`${rig.fx.url}/fake-tweets`);
    await second.goto(`${rig.fx.url}/popup?to=${encodeURIComponent(BLOCKED)}`);
    await second.click('[data-testid="open"]');

    const deadline = Date.now() + 15_000;
    const denied = (): boolean =>
      seenBySecond.some((r) => r.url === BLOCKED && r.cause === "window_open");
    while (!denied() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seenBySecond).toContainEqual({ url: BLOCKED, cause: "window_open" });
    // Attributed, not broadcast: the uninvolved page's hook was never asked about it.
    expect(seenByFirst.filter((r) => r.url === BLOCKED)).toEqual([]);
  } finally {
    await conn.close();
  }
});

it("a denial is recorded even when the task opted out of storing navigations", async () => {
  // Storage opt-outs are the user's call about their own run exhaust (§14). A security
  // signal is not run exhaust, and this is the line that says so.
  sess = await openSession(rig, { storage: { navigations: false, actions: false } });
  const { page } = sess.session;

  await page.goto(BLOCKED).catch(() => undefined);

  const rows = await waitForTrace(rig, sess, "the denial", (r) => denials(r).length > 0);
  // The blocked request still fails at the network layer (Chromium reports it as
  // `requestfailed`, same as any other refused request), so the observer (S3b) still
  // produces a `network` row for it — unaffected, because this task only opted out of
  // `navigations`/`actions`, and a failed request is not a security signal the way the
  // denial itself is, so it is not exempt from the `network` flag the way `policy_denied` is
  // exempt from every flag.
  expect(rows.map((r) => r.kind)).toEqual(["policy_denied", "network"]);
});
