import { expect, it, vi } from "vitest";
import { browserNetworkTool } from "./browser-network.js";
import { pythonFixture } from "./python-test-support.js";

it("lists earlier calls and reads bounded response content through browser.network", async () => {
  const session = pythonFixture().session;
  const list = vi.fn(async () => ({ records: [{ index: 3, method: "POST", url: "https://fixture.test/api/items", status: 201 }], total: 1 }));
  const read = vi.fn(async () => ({ response_body: { bytes: Buffer.from('{"items":[1]}'), mime: "application/json" } }));
  session.network = { list, read } as unknown as typeof session.network;
  const tool = browserNetworkTool(session);

  expect(await tool.execute({ action: "list", urlPattern: "/api/items" })).toMatchObject({ ok: true, value: { total: 1, records: [{ index: 3, status: 201 }] } });
  expect(await tool.execute({ action: "read", index: 3, parts: ["response_body"] })).toMatchObject({ ok: true, value: { response_body: { mime: "application/json", text: '{"items":[1]}' } } });
  expect(list).toHaveBeenCalledWith({ urlPattern: "/api/items", limit: undefined });
  expect(read).toHaveBeenCalledWith(3, ["response_body"]);
  expect(await tool.execute({ action: "read", index: 3 })).toMatchObject({ ok: false, error: "browser.network read requires index and parts" });
});

it("does not expose network or CAPTCHA services inside Python", async () => {
  const tool = pythonFixture().tool();
  expect(await tool.execute({ source: `assert not hasattr(browser, 'network')
assert not hasattr(browser, 'captcha')
assert 'workflow' not in globals()` })).toMatchObject({ ok: true });
});
