import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createCamoufoxWorkerDriver, type RunSession } from "@tabductor/browser";
import { localPythonRunnerForTest } from "@tabductor/agent";
import { pythonTool } from "../../packages/agent/src/python-tool.js";

it.skipIf(!process.env.CAMOUFOX_TEST_URL)("runs standard Playwright imports, events, files, handles and typed errors across cells", async () => {
  const workerUrl = process.env.CAMOUFOX_TEST_URL!;
  const token = process.env.CAMOUFOX_TEST_TOKEN ?? "harness-fixture-token";
  const sessionId = "playwright-compatibility-fixture";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-tabductor-rpc-version": "1" };
  const response = await fetch(`${workerUrl}/v1/sessions`, { method: "POST", headers,
    body: JSON.stringify({ session_id: sessionId, generation: 1, profile_dir: sessionId }) });
  expect(response.status, await response.text()).toBe(200);
  const connection = await createCamoufoxWorkerDriver({ token, sessionId, generation: 1 }).connect(workerUrl);
  const runner = localPythonRunnerForTest(fileURLToPath(new URL("../../vendor/browser-harness/src/browser_harness/tabductor_runner.py", import.meta.url))).open!({ runId: sessionId, leaseGeneration: 1 });
  try {
    const page = await connection.createPage();
    const tool = pythonTool({ session: { page } as RunSession, emit: async () => ({ outcome: "deduped" }), pythonRunner: runner });
    const result = await tool.execute({ source: `from playwright.sync_api import Page, BrowserContext, ElementHandle, JSHandle, FilePayload, expect, Error, TimeoutError
from pathlib import Path
assert isinstance(page, Page) and isinstance(context, BrowserContext)
assert page.context is context
with context.expect_page(timeout=3000) as opened:
    child = context.new_page()
assert opened.is_done() and opened.value is child
assert child.opener() is None
child.set_content("""<title>Compatibility</title><input type="file"><button onclick="window.open('about:blank')">Popup</button><output>Ready</output>""")
with child.expect_popup(timeout=3000) as popup_info:
    child.get_by_role('button', name='Popup').click()
popup = popup_info.value
assert popup.opener() is child
popup.close()
handle = child.locator('output').element_handle()
assert isinstance(handle, ElementHandle) and isinstance(handle, JSHandle)
assert handle.evaluate('(el) => el.textContent') == 'Ready'
handle.dispose()
expect.set_options(timeout=1000)
expect(child.locator('output')).to_have_text('Ready')
try:
    expect(child.locator('output')).to_have_text('Missing', timeout=1)
except AssertionError:
    pass
else:
    raise AssertionError('Expected native AssertionError')
try:
    child.locator('missing').click(timeout=1)
except TimeoutError as error:
    assert isinstance(error, Error) and error.message
else:
    raise AssertionError('Expected native TimeoutError')
Path('upload.txt').write_text('uploaded')
child.locator('input').set_input_files(Path('upload.txt'))
assert child.locator('input').evaluate('(el) => el.files[0].type') == 'text/plain'
child.locator('input').set_input_files(FilePayload(name='second.txt', mimeType='text/plain', buffer=b'second'))
child.screenshot(path=Path('nested/screenshot.jpg'))
assert Path('nested/screenshot.jpg').read_bytes().startswith(bytes([255,216]))
print('compatibility passed')` });
    expect(result).toMatchObject({ ok: true, images: [{ mime: "image/jpeg" }] });
    expect(result.ok && JSON.stringify(result.value)).toContain("compatibility passed");
    const resumed = await tool.execute({ source: `from playwright.sync_api import Page
child = next(p for p in context.pages if p.title() == 'Compatibility')
assert isinstance(child, Page) and child.context is context
child.close()
browser.done(result='persisted ownership')` });
    expect(resumed).toMatchObject({ ok: true, terminal: { outcome: "done", result: "persisted ownership" } });
  } finally {
    await runner.close!();
    await connection.close();
    await fetch(`${workerUrl}/v1/sessions/${sessionId}?generation=1`, { method: "DELETE", headers });
  }
}, 60000);
