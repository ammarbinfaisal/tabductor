import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  openSession,
  payloadOf,
  startBrowserRig,
  traceRows,
  type BrowserRig,
  type SessionRig,
} from "./browser-support.js";

/**
 * The perception builder (S4a §8), exercised against `fake-tweets` — real Chromium, real
 * anchors, real clicks through the locators `perceive()` hands out. Anchors are the whole
 * point: the agent (S4b) never sees a selector, only `e1`/`e2`/…, so this file's assertions
 * are deliberately "does the anchor round-trip to something the driver accepts", not "does
 * the perception object look right in isolation".
 */

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

it("anchors the timeline's tweets by test id, in document order, with locators that click/queryAll accept", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.waitFor('[data-testid="tweet"]');

  const perception = await page.perceive();

  expect(perception.url).toContain("/fake-tweets");
  expect(perception.title).toBe("Fake Tweets");

  const tweetArticles = perception.elements.filter((e) => e.tag === "article" && e.strategy === "testid");
  expect(tweetArticles.length).toBeGreaterThanOrEqual(3);

  // Document order: anchor numbers increase monotonically for the tweet articles.
  const anchorNumbers = tweetArticles.map((e) => Number(e.anchor.slice(1)));
  expect(anchorNumbers).toEqual([...anchorNumbers].sort((a, b) => a - b));

  // Every anchor resolves back to exactly its own recorded locator.
  for (const el of perception.elements) {
    expect(sess.session.resolveAnchor(el.anchor)).toBe(el.locator);
  }

  // The resolved locator is something `queryAll` accepts and that actually matches the
  // element `perceive()` found it at — proves the locator isn't merely well-formed but
  // resolves to the same element a second, independent driver call would find.
  const first = tweetArticles[0]!;
  const rows = await page.queryAll(first.locator, { text: { selector: '[data-testid="tweetText"]' } });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toBeTruthy();

  // A permalink anchor is disambiguated via the "text" tier (all three share the same
  // visible text, "permalink") — clicking its locator must land on that tweet's own page,
  // proving the driver's `click` accepts the same locator syntax `queryAll` just did.
  const permalink = perception.elements.find((e) => e.tag === "a" && e.strategy === "text");
  expect(permalink).toBeDefined();
  await page.click(permalink!.locator);
  expect(page.url()).toContain("/fake-tweets/status/");

  // §16 Threat 1: no raw HTML anywhere in the extracted text.
  expect(perception.text).not.toContain("<");
  for (const el of perception.elements) {
    expect(el.text ?? "").not.toContain("<");
    expect(el.locator).not.toContain("<script");
  }

  await sess.trace.flush();
  const rows2 = await traceRows(rig, sess.runId);
  const perceiveRow = rows2.find((r) => payloadOf(r).action === "perceive")!;
  expect(perceiveRow).toBeDefined();
  expect(payloadOf(perceiveRow)).toMatchObject({ ok: true });
  expect(payloadOf(perceiveRow).elementCount).toBeGreaterThan(0);
  // The trace records counts, never the page's own words.
  expect(JSON.stringify(rows2)).not.toContain("first tweet");
});

it("chooses the test-id tier for every [data-testid] element, even though the id repeats across tweets", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.waitFor('[data-testid="tweet"]');
  const perception = await page.perceive();

  const testIdElements = perception.elements.filter((e) => e.locator.includes("[data-testid="));
  expect(testIdElements.length).toBeGreaterThanOrEqual(3);
  expect(testIdElements.every((e) => e.strategy === "testid")).toBe(true);
});

it("assigns the same anchors to the same fixture state (deterministic, document order)", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.waitFor('[data-testid="tweet"]');

  const first = await page.perceive();
  const second = await page.perceive();

  expect(second.elements.map((e) => ({ anchor: e.anchor, locator: e.locator, strategy: e.strategy }))).toEqual(
    first.elements.map((e) => ({ anchor: e.anchor, locator: e.locator, strategy: e.strategy })),
  );
});

it("truncates the text budget on a long page, with a marker, and never emits raw HTML", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  // Grow the timeline well past a small budget — the fixture's own three tweets aren't
  // enough to force truncation, so this test pads it out first.
  for (let i = 0; i < 40; i++) {
    await fetch(`${rig.fx.url}/fake-tweets/admin/add-tweet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `pad_${i}`,
        text: `padding tweet number ${i} with enough words to add up to a real text budget over many repeats`,
      }),
    });
  }

  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.waitFor('[data-testid="tweet"]');

  const budgeted = await page.perceive({ maxChars: 500 });
  expect(budgeted.text.length).toBeLessThan(600); // budget + the truncation marker's own text
  expect(budgeted.text).toContain("truncated");
  expect(budgeted.text).not.toContain("<");

  const unbudgeted = await page.perceive({ maxChars: 100_000 });
  expect(unbudgeted.text.length).toBeGreaterThan(budgeted.text.length);
  expect(unbudgeted.text).not.toContain("truncated");
});
