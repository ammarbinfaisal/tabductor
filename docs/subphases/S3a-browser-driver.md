# S3a — Browser driver + navigation guard + trace recorder

You are implementing subphase S3a. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 3 (driver interface, navigation guard, trace recorder bullets).
3. `docs/techical_plan.md` — §8 (Browser Runtime), §10 enforcement point (c), §14 (trace_entries, artifacts).
4. `docs/subphases/ROADMAP.md` — stack/style rules.

Existing code to reuse (read first, match style): `packages/core`, `packages/db`, `packages/bus`,
`packages/policy` (PolicyGate — every navigation check goes through it), `packages/engine`,
`apps/testkit` (`launchChrome` is your CDP endpoint for tests; fixture sites are your targets).
Endpoint pooling, per-endpoint queues, the network observer, and resource limits are S3b — NOT
yours. Design so S3b slots in, but do not build it.

## Deliverables

1. **`packages/browser`**
   - **Driver interface** (§20 insulation — this is one of the few sanctioned abstractions):
     `connect(wsUrl) → BrowserConn`; `BrowserConn.createPage() → Page`; `Page.goto(url)`,
     `click(selector)`, `type(selector, text)`, `waitFor(selector, {timeout})`,
     `queryAll(selector, attrs) → extracted records`, `screenshot() → Buffer`, `title()`,
     `close()`; `BrowserConn.close()`. Keep the surface to what Phase 3–4 needs — do NOT
     mirror all of Playwright.
   - **Playwright implementation** via `playwright-core` `connectOverCDP` (no bundled
     browsers — dep is `playwright-core` only; tests connect to testkit's launched Chrome).
   - **Navigation guard:** every navigation — initial `goto`, redirects, `window.open`,
     script-driven — passes `PolicyGate.checkNavigation(taskCtx, url, cause)` BEFORE it
     proceeds. Implement with Playwright route interception (`context.route('**/*')` on
     document requests) so redirects are caught mid-flight; denied → abort the request,
     record a `policy_denied` trace entry, and surface a typed error to the caller for the
     initial goto case. `window.open` → new page inherits the same guard (context-level
     routing covers it; verify with a test).
   - **Trace recorder:** `createTraceRecorder(db, blobs, runId, storageFlags)` → `record(kind, payload, blob?)`
     appending to `trace_entries` (seq monotonic per run; buffered writes, flushed on demand
     and on close). Blobs (screenshots) go to a **BlobStore** — interface with ONE method pair
     (`put(bytes, meta) → blobRef`, `get(blobRef)`) and a filesystem implementation rooted at
     config `BLOB_DIR`. Storage opt-out flags (per-task `limits_json.storage`) checked at
     write time: a category opted out is simply not written (design doc: evaluate at write
     time, don't store-then-delete).
   - **Session wiring:** a `openRunSession({conn, gate, taskCtx, trace}) → { page, close }`
     composition that gives callers a guarded, traced page — actions (`goto/click/type/...`)
     each record a trace entry with the resolved selector and outcome. This is what executors
     (S3b's scripted, S4's agent) will drive.
   - Schema: `trace_entries` and `artifacts` tables may need creation if S1 trimmed them —
     add via `pnpm --filter @tabductor/db generate` migration; follow §14
     (`trace_entries(run_id, seq, kind, payload_json, blob_ref)`, pk `(run_id, seq)`).

2. **System tests** (`tests/system/`, content-named, e.g. `browser-driver.test.ts`,
   `navigation-guard.test.ts`, `trace-recorder.test.ts`; real Chrome via testkit +
   fixture sites):
   - Driver flow: connect → goto fake-tweets → waitFor timeline → `queryAll` extracts ≥3
     tweets (text, href, datetime) → screenshot returns a PNG buffer → trace has navigation +
     action entries in seq order with resolved selectors.
   - Navigation guard: gate allowlist = fixture host only; `goto` to `https://example.com`
     → typed denial error, `policy_denied` trace entry, page never leaves origin. Redirect
     case: fixture endpoint 302→example.com (add a tiny `/redirect?to=` route to the fixture
     server if missing) → aborted mid-flight, denial traced. `window.open('https://example.com')`
     from page script → blocked, denial traced.
   - Trace blobs: screenshot lands in fs BlobStore; `blob_ref` resolves via `get`; with
     `storage.screenshots=false` → no artifact row, no blob file, action entries still present.

## Style constraints (binding)
- The driver interface + BlobStore are the only new interfaces. No BrowserManager class, no
  event-emitter wrappers, no retry layer (S3b owns queueing).
- Playwright types stay inside the impl file — the interface exposes plain data.
- New deps: `playwright-core` only.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests stay green. Run twice; Chrome tests must not leak processes or profiles
(check no stray "Google Chrome for Testing"/headless processes after the suite).

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Do NOT git commit.
