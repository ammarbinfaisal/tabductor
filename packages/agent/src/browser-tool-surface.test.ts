import { expect, it } from "vitest";
import type { RunSession } from "@tabductor/browser";
import { buildToolRegistry } from "./tools.js";
import { pythonFixture } from "./python-test-support.js";

const retired = ["checkpoint.get", "checkpoint.set", "code.status", "page.verify", "harness.verify"];

it("removes retired APIs from the registry and nested JavaScript catalog", async () => {
  const store = { get: async () => ({}), set: async () => {} };
  const tools = buildToolRegistry({ session: { page: { harness: async () => null } } as unknown as RunSession,
    emit: async () => ({ outcome: "deduped" }), checkpoint: store, progress: store });
  for (const name of retired) {
    expect(tools.some(tool => tool.name === name)).toBe(false);
    expect(tools.map(tool => tool.description).join("\n")).not.toContain(name);
    expect(await tools.find(tool => tool.name === "browser.code")!.execute({
      source: `export default async api => api.call(${JSON.stringify(name)}, {})`,
    })).toMatchObject({ ok: false, error: expect.stringContaining("unavailable") });
  }
});

it("does not advertise or expose retired Python services or a workflow global", async () => {
  const tool = pythonFixture().tool();
  expect(tool.description).not.toMatch(/checkpoint|browser\.status|record\.verify|verification/i);
  expect(await tool.execute({ source: `names = browser.describe()['services']
assert 'workflow' not in globals()
assert not any('checkpoint' in name or name in ['browser.status', 'browser.record.verify'] for name in names)
for name in ['checkpoint', 'checkpoint_files', 'status']:
    assert not hasattr(browser, name)
assert not hasattr(browser.record, 'verify')
browser.done()` })).toMatchObject({ ok: true, terminal: { outcome: "done" } });
});

it.each(["browser.checkpoint.get()", "browser.checkpoint.set(value={})", "browser.status()", "browser.record.verify()", "browser.checkpoint_files()"])(
  "rejects retired Python service %s", async source => {
    expect(await pythonFixture().tool().execute({ source })).toMatchObject({ ok: false, error: expect.stringContaining("Unknown browser method") });
  });

it.each([false, true])("permits task completion without a verification call (compiled: %s)", async compiled => {
  const body = "page.locator('input').fill('current value')\nbrowser.done(result='finished')";
  const source = compiled ? "def run(page, context, browser):\n" + body.split("\n").map(line => "    " + line).join("\n") : body;
  expect(await pythonFixture().tool({ compiled }).execute({ source })).toMatchObject({ ok: true, terminal: { outcome: "done", result: "finished" } });
});
