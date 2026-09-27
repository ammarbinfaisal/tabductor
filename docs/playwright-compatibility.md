# Playwright compatibility

Browser agents are instructed to **use Playwright directly**: normal synchronous Python imports from `playwright.sync_api`, with `page` and `context` already supplied. The injected `browser` object provides inputs, events, CAPTCHA solving, network history and completion.

```python
from playwright.sync_api import Page, expect, TimeoutError

expect.set_options(timeout=5000)
page.get_by_role("button", name="Save").click()
expect(page.get_by_text("Saved", exact=True)).to_be_visible()

with context.expect_page() as opened:
    child = context.new_page()
assert opened.value is child
child.close()

page.screenshot(path="screenshots/result.png")
browser.done()
```

## Contract

The installed worker pins **Playwright 1.55.0**. The generator discovers every class from that release's generated sync API, including returned-object types not re-exported by its package. The checked-in contract contains **36 classes and 646 public members**. Runtime classes derive their signatures, defaults, properties and inheritance from that contract. Public typed dictionaries and aliases are also importable. The only omitted package export is `sync_playwright`, since startup is outside the agreed scope.

Compatibility includes stable object identity within a cell, `ElementHandle`/`JSHandle` inheritance, bound and unbound method calls, keyword arguments, regexes, callbacks, event context managers returning an event result with `value` and `is_done()`, `expect.set_options()`, `Error`/`TimeoutError`, and assertion failures raised as `AssertionError`.

Returned Clock, Worker, WebError, Browser, Video and Tracing objects use the same transport. `context.new_page()` creates a native page without inventing an opener. The worker records its task ownership separately and preserves it between Python cells.

File paths refer to the Python workspace. Uploads, script/style files, HAR input, screenshot/PDF output, storage-state output, downloads, video and trace archives transfer their data rather than expose worker filesystem paths. Screenshot paths infer PNG/JPEG format and output directories are created locally.

## Runtime boundaries

Complete public API coverage does **not** mean unrestricted or engine-independent Playwright. These boundaries remain explicit:

- The host manages browser startup, attachment, new browser contexts, shared-context disposal and browser shutdown. Agents use the supplied browser objects.
- A task can inspect and operate on its owned pages. Context-wide operations that would affect another task's page are rejected. Browser context enumeration exposes only the leased context.
- Camoufox/Firefox has its own native feature support; Chromium-only APIs such as PDF generation and CDP sessions remain unavailable on this backend.
- Camoufox's normal evaluation world is retained. Its `mw:` extension provides JSON-only evaluation of application globals; main-world handles are not supported.
- Existing host budgets remain: transfers are bounded, and cells/calls have deadlines.
- HAR replay is supported; HAR updating requires closing the host-owned context and is rejected. Worker filesystem paths remain private. Uploads accept individual files, directories and file payloads within the transfer budget.
- Globals and callbacks persist across cells in the same run interpreter. Browser state and workspace files survive interpreter resets; old `browser_harness` imports remain compatible for saved helpers.

These are documented runtime limitations, not missing names silently omitted from the API contract. Signature coverage alone does not prove every possible behavioral combination; regressions are checked with the tests below.

## Verification

- `apps/browser-worker/tests/test_playwright_compatibility.py` compares all 646 members and argument signatures against installed native Playwright, checks exports, inheritance, identity, event results, assertion options and local file behavior.
- `apps/browser-worker/tests/test_playwright_proxy.py` exercises real Camoufox objects, callbacks, routes, events, context settings, cookies/storage, clocks, workers, trace files and ownership boundaries.
- `tests/system/playwright-compatibility.test.ts` runs ordinary Playwright Python through the runner, TypeScript gateway and worker, including events, uploads, JPEG screenshots, typed errors and ownership across cells.
- The existing Python compilation, workspace, callback replay, control-reconciliation and browser-driver tests cover the surrounding runtime.

API references: [Playwright Python](https://playwright.dev/python/docs/api/class-playwright), [BrowserContext](https://playwright.dev/python/docs/api/class-browsercontext), [assertions](https://playwright.dev/python/docs/test-assertions). The installed 1.55.0 package, rather than the evolving website, is authoritative for the checked-in contract.
