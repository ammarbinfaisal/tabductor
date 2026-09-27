import { afterAll, beforeAll, expect, it } from "vitest";
import { browserNetworkTool } from "../../packages/agent/src/browser-network.js";
import { openSession, startBrowserRig, type BrowserRig } from "./browser-support.js";

let rig: BrowserRig;
beforeAll(async () => { rig = await startBrowserRig(); });
afterAll(async () => { await rig?.close(); });

it("reads a response captured before the tool call", async () => {
  const owned = await openSession(rig);
  try {
    await owned.session.page.goto(`${rig.fx.url}/fake-tweets`);
    await owned.session.network.waitForResponse({ urlPattern: "/api/timeline", timeout: 10000 });

    const tool = browserNetworkTool(owned.session);
    const listed = await tool.execute({ action: "list", urlPattern: "/api/timeline" });
    expect(listed).toMatchObject({ ok: true, value: { records: [{ status: 200 }] } });
    const records = (listed as { value: { records: Array<{ index: number }> } }).value.records;
    const result = await tool.execute({ action: "read", index: records[0]!.index, parts: ["response_body"] });
    expect(result).toMatchObject({ ok: true, value: { response_body: { mime: expect.stringContaining("application/json") } } });
    const body = (result as { value: { response_body: { text: string } } }).value.response_body.text;
    expect(JSON.parse(body).tweets).toHaveLength(3);
  } finally {
    await owned.close();
  }
});
