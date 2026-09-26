# Run investigation — 24 September 2026

Workflow: `wf_0b26369d-2383-4c5a-9195-b848f409c9e4`
Run: `run_ebf3f593-fa98-4eae-a793-3f7b7d58ebaf`

## Outcome

The run is recorded as `awaiting_human`, not `failed`. It started at 09:22:54 UTC and requested human assistance around 09:28:56 UTC. The final observed Google sign-in page asked for a password; Notion remained signed out. Trace sequence 2365 contains the password-page text, and sequence 2382 requests human action. No `workflow.done`, event publication or destination-contract publication was recorded.

The browser session associated with this execution was subsequently marked `ended`. Completing authentication requires an available session; the historical handoff text alone does not establish that its browser window is still open.

## Errors before the handoff

The trace contains 70 LLM entries and 54 completed model tool calls, 24 of which returned errors. Some successful cells caught browser exceptions, so tool-call success does not mean their browser operations succeeded.

| Finding | Evidence |
| --- | --- |
| Missing standard Playwright module | Sequences 1636 and 1862: `from playwright.sync_api import TimeoutError` raised `ModuleNotFoundError: No module named 'playwright'`. |
| Sync/async confusion | Sequences 364, 1775 and 2102 used `await` against the synchronous runtime and failed before executing. |
| Browser invocation interruption | 41 operation results returned HTTP 409: 11 during polling and 30 during submission. Four more returned `CancelledError` (1347, 1463, 1818 and 2151). |
| Repeated login attempts | Cells repeatedly clicked Google, attempted popup discovery and enumerated pages while the above errors continued. |
| Screenshot overhead | Sequence 766 printed the return value of `page.screenshot(path='/workspace/notion.png')`. This prints raw image bytes and persists the image as a workspace file; later cells restored and checkpointed that file. |

The interruption pattern is consistent with ownership reconciliation cancelling active proxy scopes. The fleet sends `/control` every reconciliation cycle (timer: one second). The earlier control ordering drained commands even when the owner and generation were unchanged; draining closes proxy scopes. That explains cancelled operations followed by missing-invocation 409s. The current working tree already contains an early return for unchanged ownership, plus typed invocation-expiry errors and regression coverage. Those fixes preceded this investigation.

The historical trace reduced the HTTP response to a generic 409 message, and the original worker container is no longer available. Consequently, the precise reason for every historical 409 cannot be established from this trace alone.

## Changes from this investigation

- Expose `browser.screenshot({selector?})` beside `browser.python`, returning an image attachment directly without a Python cell or workspace file.
- Expose the scoped browser API as `playwright.sync_api`, including public object types, `expect`, `Error` and `TimeoutError`. Browser timeout codes now raise that imported timeout type.
- Preserve legacy `browser_harness` imports for saved helpers and programs. Browser launch and runtime-internal imports remain unavailable.
- Update execution guidance, no-tool-call recovery and compilation prompts for the two-tool registry and standard import path.

The import and screenshot changes address observed runtime friction. They do not supply the missing Google password or complete the workflow's authentication.

## Validation

Passed 66 targeted unit tests, 23 browser-worker fencing tests and one live Camoufox integration test. The live test checks screenshot delivery to the model, standard imports, Python compilation, a second record written without a model, and recovery after layout changes and delayed writes. TypeScript checking and targeted source lint also passed. Tests used a disposable browser worker; existing application services were not redeployed.
