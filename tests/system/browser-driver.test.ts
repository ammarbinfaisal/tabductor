import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { playwrightDriver } from "@tabductor/browser";
import { runAgentLoop } from "@tabductor/agent";
import { buildToolRegistry } from "../../packages/agent/src/tools.js";
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
  // Two `network:` rows join the sequence (S3b) — the document request and the timeline
  // XHR fake-tweets fires — landing wherever their response settled relative to the action
  // that was in flight when it did, which is not necessarily after that action's own entry.
  expect(rows.map((r) => `${r.kind}:${payloadOf(r).action ?? payloadOf(r).cause ?? ""}`)).toEqual([
    "runtime:",
    "navigation:initial",
    "network:",
    "action:goto",
    "network:",
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

it("extracts Playwright field selectors per row with nulls for missing fields", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;
  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.waitFor('[data-testid="tweet"]');
  const records = await page.queryAll('[data-testid="tweet"]', {
    text: { selector: '[data-testid="tweetText"]:has-text("tweet")' },
    missing: { selector: 'span:has-text("Ad"), span:has-text("Promoted")' },
    href: { selector: 'a:has-text("")', attr: "href" },
    own: {},
  });
  expect(records.length).toBeGreaterThanOrEqual(3);
  expect(records[0]).toMatchObject({ text: "first tweet", missing: null, href: "/fake-tweets/status/t1" });
  expect(records[1]!.text).not.toBe(records[0]!.text);
  expect(records[0]!.own).toContain("first tweet");
  await expect(page.queryAll(".no-such-root", {
    promoted: { selector: "span[" },
  })).rejects.toMatchObject({
    code: "browser.invalid_extract_selector",
    details: { field: "promoted", selector: "span[" },
  });
});

it("returns an actionable extraction error to the agent and supports a corrected retry", async () => {
  sess = await openSession(rig);
  await sess.session.page.goto(`${rig.fx.url}/fake-tweets`);
  await sess.session.page.waitFor('[data-testid="tweet"]');
  let turn = 0;
  const result = await runAgentLoop({
    tools: buildToolRegistry({ session: sess.session, emit: async () => ({ outcome: "deduped" }) }),
    task: { prompt: "Read tweet text." }, trigger: null, emits: [], trace: sess.trace,
    llm: { async complete(req) {
      const step = turn++;
      if (step === 1) {
        expect(req.messages.at(-1)!.content).toContain("Invalid extraction selector");
        expect(req.messages.at(-1)!.content).toContain("retry page.extract");
      }
      if (step === 2) {
        expect(req.messages.at(-1)!.content).toContain("first tweet");
        expect(req.messages.at(-1)!.content).toContain('"ok":true');
      }
      return { usage: { in: 0, out: 0 }, toolCalls: [...(step === 2 ? [{id:"verify",name:"page.verify",args:{textIncludes:"first tweet"}}] : []),{
        id: String(step), name: step === 2 ? "done" : "page.extract",
        args: step === 2 ? { result: "read" } : { fields: {
          text: { selector: step === 0 ? "span[" : '[data-testid="tweetText"]:has-text("first")' },
        } },
      }] };
    } },
  });
  expect(result.outcome).toBe("done");
  expect(turn).toBe(3);
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
