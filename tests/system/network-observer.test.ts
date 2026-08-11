import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  openSession,
  startBrowserRig,
  traceRows,
  waitForNetwork,
  waitForTrace,
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

it("lists the document request and the timeline XHR, and both land in the trace", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.waitFor('[data-testid="tweet"]');

  const records = await waitForNetwork(sess, (rs) =>
    rs.some((r) => r.url.endsWith("/api/timeline") && r.status !== null),
  );

  const doc = records.find((r) => r.url === `${rig.fx.url}/fake-tweets`);
  expect(doc).toMatchObject({ method: "GET", resourceType: "document", status: 200 });
  expect(doc!.timings.durationMs).toBeGreaterThanOrEqual(0);

  const timeline = records.find((r) => r.url.endsWith("/api/timeline"));
  expect(timeline).toMatchObject({
    method: "GET",
    resourceType: "xhr",
    status: 200,
    url: `${rig.fx.url}/fake-tweets/api/timeline`,
  });

  // Dense and stable — every index up to the highest one seen is present exactly once.
  const indices = records.map((r) => r.index).sort((a, b) => a - b);
  expect(indices).toEqual([...indices.keys()]);

  const rows = await waitForTrace(rig, sess, "the network rows", (r) =>
    r.filter((x) => x.kind === "network").length >= 2,
  );
  const netRows = rows.filter((r) => r.kind === "network");
  expect(netRows.map((r) => (r.payloadJson as { url: string }).url)).toEqual(
    expect.arrayContaining([doc!.url, timeline!.url]),
  );
});

it("fetches a response body lazily, and the read is recorded but the body never is", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.waitFor('[data-testid="tweet"]');

  const records = await waitForNetwork(sess, (rs) =>
    rs.some((r) => r.url.endsWith("/api/timeline") && r.status !== null),
  );
  const timeline = records.find((r) => r.url.endsWith("/api/timeline"))!;

  const body = await sess.session.network.body(timeline.index);
  const parsed = JSON.parse(body.toString("utf8")) as { tweets: { text: string }[] };
  expect(parsed.tweets.map((t) => t.text)).toContain("first tweet");

  await sess.trace.flush();
  const rows = await traceRows(rig, sess.runId);
  const readRow = rows.find(
    (r) => r.kind === "action" && (r.payloadJson as { action?: string }).action === "network.body",
  )!;
  expect(readRow.payloadJson).toMatchObject({
    index: timeline.index,
    url: timeline.url,
    size: body.byteLength,
    ok: true,
  });

  // The read is on the record; the tweets themselves are not (§14 — page/network content is
  // opt-in, and a trace that quoted a body would smuggle it in under a category never chosen).
  expect(JSON.stringify(rows)).not.toContain("first tweet");
});

it("a storage opt-out for network drops the records and bodies, and the rest of the trace survives", async () => {
  sess = await openSession(rig, { storage: { network: false } });
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.waitFor('[data-testid="tweet"]');

  const records = await waitForNetwork(sess, (rs) =>
    rs.some((r) => r.url.endsWith("/api/timeline") && r.status !== null),
  );
  const timeline = records.find((r) => r.url.endsWith("/api/timeline"))!;
  await sess.session.network.body(timeline.index);

  await sess.trace.flush();
  const rows = await traceRows(rig, sess.runId);

  expect(rows.filter((r) => r.kind === "network")).toEqual([]);
  // Still traced as actions, still governed by `actions` rather than `network` (which was the
  // only flag this session turned off) — `network.body`'s bytes are what disappear, not the
  // fact that it was called.
  expect(rows.some((r) => (r.payloadJson as { action?: string }).action === "network.list")).toBe(
    true,
  );
  const bodyRow = rows.find(
    (r) => (r.payloadJson as { action?: string }).action === "network.body",
  )!;
  expect(bodyRow.blobRef).toBeNull();
  expect(rows.some((r) => r.kind === "navigation")).toBe(true);
});

it("truncates network.list and reports the true total", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.waitFor('[data-testid="tweet"]');
  await waitForNetwork(sess, (rs) => rs.some((r) => r.url.endsWith("/api/timeline") && r.status !== null));

  const { records: full } = await sess.session.network.list();
  const { records: capped, total } = await sess.session.network.list({ limit: 1 });
  expect(capped).toHaveLength(1);
  expect(total).toBe(full.length);
  expect(total).toBeGreaterThanOrEqual(2);
});

it("continues the index sequence for a second tab", async () => {
  sess = await openSession(rig);
  const { session } = sess;

  await session.page.goto(`${rig.fx.url}/fake-tweets`);
  await session.page.waitFor('[data-testid="tweet"]');
  const firstTabRecords = await waitForNetwork(sess, (rs) =>
    rs.some((r) => r.url.endsWith("/api/timeline") && r.status !== null),
  );
  const firstTabCount = firstTabRecords.length;

  const tab = await session.openTab();
  await tab.goto(`${rig.fx.url}/fake-gram`);

  const all = await waitForNetwork(sess, (rs) => rs.length > firstTabCount);
  const indices = all.map((r) => r.index).sort((a, b) => a - b);
  expect(indices).toEqual([...indices.keys()]);
  expect(all.some((r) => r.url === `${rig.fx.url}/fake-gram`)).toBe(true);
});
