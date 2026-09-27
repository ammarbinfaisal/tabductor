import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { openSession, payloadOf, startBrowserRig, waitForTrace, type BrowserRig, type SessionRig } from "./browser-support.js";

let rig: BrowserRig;
let sess: SessionRig | undefined;

beforeAll(async () => { rig = await startBrowserRig(); });
afterEach(async () => { await sess?.close(); sess = undefined; });
afterAll(async () => { await rig?.close(); });

it("allows navigation, page interactions and captured network reads without policy verdicts", async () => {
  sess = await openSession(rig);
  const { page, network } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  const response = await network.waitForResponse({ urlPattern: "/api/timeline", timeout: 10000 });
  const body = await network.read(response.index, ["response_body", "response_headers"]);
  expect(body.response_body?.bytes.toString()).toContain("tweets");
  expect(body.response_headers).toBeDefined();

  const dest = `${rig.fx.url}/fake-tweets`;
  await page.goto(`${rig.fx.url}/popup?to=${encodeURIComponent(dest)}`);
  await page.click('[data-testid="open"]');
  const rows = await waitForTrace(rig, sess, "the popup navigation", rows =>
    rows.some(row => row.kind === "navigation" && payloadOf(row).url === dest));
  expect(rows.filter(row => row.kind === "policy_denied")).toEqual([]);
});
