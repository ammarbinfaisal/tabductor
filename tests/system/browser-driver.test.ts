import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { playwrightDriver } from "@tabductor/browser";
import {
  openSession,
  payloadOf,
  startBrowserRig,
  traceRows,
  type BrowserRig,
  type SessionRig,
} from "./browser-support.js";

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

it("drives a real CDP endpoint end to end and traces what it did", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.waitFor('[data-testid="tweet"]');

  expect(await page.title()).toBe("Fake Tweets");

  const tweets = await page.queryAll('[data-testid="tweet"]', {
    text: { selector: '[data-testid="tweetText"]' },
    href: { selector: "a", attr: "href" },
    datetime: { selector: "time", attr: "datetime" },
  });
  expect(tweets.length).toBeGreaterThanOrEqual(3);
  expect(tweets[0]).toEqual({
    text: "first tweet",
    href: "/fake-tweets/status/t1",
    datetime: "2026-01-01T00:00:00.000Z",
  });

  const shot = await page.screenshot();
  // PNG magic number — proof it is an image rather than an empty buffer.
  expect(shot.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  await sess.trace.flush();
  const rows = await traceRows(rig, sess.runId);

  // Ordering is the assertion: `seq` is what the Phase 6 checker reads traces by.
  expect(rows.map((r) => r.seq)).toEqual([...rows.keys()]);
  expect(rows.map((r) => `${r.kind}:${payloadOf(r).action ?? payloadOf(r).cause ?? ""}`)).toEqual([
    "navigation:initial",
    "action:goto",
    "action:waitFor",
    "action:queryAll",
    "action:screenshot",
  ]);

  const extraction = rows.find((r) => payloadOf(r).action === "queryAll")!;
  expect(payloadOf(extraction)).toMatchObject({
    selector: '[data-testid="tweet"]',
    fields: ["text", "href", "datetime"],
    count: tweets.length,
    ok: true,
  });

  // The resolved selector, not the extracted text: §14 makes page content opt-in, and an
  // action entry that quoted the page would smuggle it in under a category nobody chose.
  expect(JSON.stringify(rows)).not.toContain("first tweet");
});

it("records the failure as well as the success", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-gram`);
  await expect(page.waitFor("#nothing-here", { timeout: 500 })).rejects.toThrow();

  await sess.trace.flush();
  const rows = await traceRows(rig, sess.runId);
  const failed = rows.find((r) => payloadOf(r).action === "waitFor")!;
  expect(payloadOf(failed).ok).toBe(false);
  expect(String(payloadOf(failed).error)).toContain("#nothing-here");
});

it("fills a form and the server sees the value", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-gram`);
  await page.type('#login input[name="username"]', "ada");
  await page.type('#login input[name="password"]', "hunter2");
  await page.click('#login button[type="submit"]');
  await page.waitFor('[data-testid="result"]');

  const res = await fetch(`${rig.fx.url}/fake-gram/admin/submissions`);
  const { submissions } = (await res.json()) as {
    submissions: { kind: string; fields: Record<string, string> }[];
  };
  expect(submissions.at(-1)).toMatchObject({
    kind: "login",
    fields: { username: "ada", password: "hunter2" },
  });

  // The value went to the page but never to the trace — the property S5b's secrets broker
  // depends on, asserted here where `type` is implemented rather than there.
  await sess.trace.flush();
  expect(JSON.stringify(await traceRows(rig, sess.runId))).not.toContain("hunter2");
});

it("closing a connection detaches from the browser instead of killing it", async () => {
  const conn = await playwrightDriver.connect(rig.chrome.wsUrl);
  expect(await conn.version()).toMatch(/\d+\./);
  await conn.close();

  // The endpoint belongs to the user (§8 BYO-CDP). If `close()` ended their browser, S3b's
  // pool would take the whole endpoint down every time a run finished.
  const again = await playwrightDriver.connect(rig.chrome.wsUrl);
  expect(await again.version()).toMatch(/\d+\./);
  await again.close();
});
