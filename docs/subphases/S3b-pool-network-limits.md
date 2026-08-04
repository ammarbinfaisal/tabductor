# S3b — Endpoint pool, per-endpoint queue, network observer, resource limits

You are implementing subphase S3b. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 3 (endpoint pool, network observer, resource limits,
   ScriptedBrowserExecutor bullets).
3. `docs/techical_plan.md` — §8 (session/connection model), §9 (network visibility steps 1–2,
   5), §15 (backpressure).
4. `docs/subphases/ROADMAP.md`.

Existing code to reuse (read first): `packages/browser` (driver, navigation guard, trace
recorder, BlobStore, `openRunSession`), `packages/engine` (executor contract, run state,
`createEngine`), `packages/bus`, `packages/db`, testkit. The LLM-facing `network.read` tool
gating is S4/S7 — here you only OBSERVE and RECORD network traffic and expose a typed query
API over the observed records.

## Deliverables (extend `packages/browser` + `packages/db`; new package only if genuinely warranted)

1. **`cdp_endpoints` table** (migration; §14): `id, user_id null for now, ws_url, label,
   healthy bool, last_checked_at`. Plaintext ws_url is acceptable this phase ONLY because
   single-user local; leave a `-- TODO S7: encrypt` comment.
2. **Endpoint pool**: `createEndpointPool(db, {healthCheckMs})` — maintains one
   `BrowserConn` per endpoint, lazily connected; health loop pings (`Browser.getVersion`
   via a driver `ping()` — add to the driver interface); on failure marks unhealthy,
   reconnects with backoff; recovery flips healthy. Dropped connection mid-run → in-flight
   runs fail with error `browser.disconnected` + system event `browser.disconnected`.
3. **Per-endpoint serialization**: runs against one endpoint execute one at a time. The
   lease is a DB row (`endpoint_leases(endpoint_id pk, run_id, heartbeat_at)`) so it holds
   across engine restarts; stale-heartbeat leases are reapable. Waiting runs queue (FIFO by
   run creation) with a max queue depth (endpoint column, default 10); beyond depth → run
   fails `endpoint_queue_full`. Two endpoints run in parallel.
4. **Network observer**: subscribe to the page's network events in the driver impl
   (Playwright `page.on('request'/'response')` is sufficient — note in code that raw CDP
   `Network.*` is the fallback if Playwright's view proves too lossy). Normalized records
   `{index, method, url, resourceType, status, timings}` accumulated per run session,
   written to the trace (`kind: 'network'`), queryable via `session.network.list({urlPattern?, limit})`
   with truncation ("+N more") per §9 step 2. Response bodies: fetched lazily via
   `session.network.body(index)` (driver `responseBody(request)`) — nothing calls it yet
   except tests; it exists so S4's tool is a thin wrapper. Body reads go through
   `PolicyGate.checkNetworkRead` (permissive now) and are recorded in the trace.
5. **Resource limits** (runtime-enforced, §8): per-task `limits_json.browser`:
   `{max_tabs, max_visits, max_wall_ms}`. Counters live in the session (tab create / goto
   increment); breach → abort the run with error `resource_limit_exceeded` (typed), trace
   entry records which limit.
6. **ScriptedBrowserExecutor** (test-only, lives in testkit): executes a JSON list of
   session actions (`goto/click/waitFor/extract/openTab/networkList/networkBody`) from
   `limits_json.script`. Registered as executor for mode `scripted`. This is the harness
   that exercises browser+engine together before an agent exists — NOT the compiler's
   static runtime.

## System tests (`tests/system/`, content-named; real Chrome, fixture sites)
- Scripted flow end-to-end through the ENGINE (event → dispatch → ScriptedBrowserExecutor →
  fake-tweets → extract → emit): trace contains navigation, actions, network records
  including the timeline XHR; emitted event carries extracted data.
- Serialization: two runs queued on one endpoint → non-overlapping execution windows
  (assert via trace timestamps); two endpoints → overlapping allowed.
- Queue depth: depth=1 endpoint with a slow run + 2 more queued → one queues, one fails
  `endpoint_queue_full`.
- Lease recovery: write a stale lease row, boot pool → lease reaped, queued run proceeds.
- Kill Chrome mid-run (testkit `chrome.close()` or SIGKILL the pid) → run fails
  `browser.disconnected`, system event published, endpoint marked unhealthy; relaunch →
  health flips back and a new run succeeds.
- Resource limits: script visiting pages past `max_visits` → `resource_limit_exceeded`,
  trace shows the breach; same for `max_tabs`.
- Network body: `networkBody` on the timeline XHR returns the JSON; recorded in trace.

## Style constraints (binding)
- No generic queue/pool library abstraction — the lease table + one in-process waiter per
  endpoint is the whole mechanism. No RxJS, no p-queue.
- Prefer less code; reuse `openRunSession` — do not fork a second session type.
- New deps: none expected. Justify anything you add.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests stay green. Run twice; no leaked Chrome processes or test DBs.

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Do NOT git commit.
