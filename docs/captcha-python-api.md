# CAPTCHA Python API and browser tool

The injected Python `captcha` object and the top-level `browser.captcha` model tool expose CapSolver, 2Captcha and Anti-Captcha through the host. Use `browser.python` with the existing `page` and `context` to observe a challenge and apply a ready solution. Provider credentials and outbound provider requests stay on the engine.

## API

Inside `browser.python`, call these synchronous methods directly. The `captcha` object is available in REPL cells, helper functions and compiled `run(page, context, browser)` functions without an import. Methods are enabled when the run has a CAPTCHA service.

```python
providers = captcha.providers()
job = captcha.solve(
    provider="2captcha",
    task={"type": "TurnstileTaskProxyless", "websiteURL": page.url, "websiteKey": "observed-site-key"},
    idempotency_key="login-challenge-1",
    wait_ms=90000,
)
if job["status"] in ("pending", "submitting"):
    job = captcha.wait(job_id=job["id"], wait_ms=90000)
if job["status"] == "ready":
    solution = job["solution"]  # Apply using the observed site callback or fields, then verify acceptance.
```

`captcha.create_task(provider=..., task={...}, idempotency_key=..., options={...})` submits without waiting; `options` is optional and is also accepted by `solve`. `captcha.get_result(job_id=...)` reads or polls a job. `captcha.push_variable(job_id=..., name=..., value=...)` supplies an AntiGate variable. Use `browser.describe()` to discover available services and `browser.describe(name="captcha.solve")` for an exact argument schema. The agent loop system prompt documents all six methods.

The same operations are available as separate calls to the `browser.captcha` model tool:

```json
{"action":"providers"}
{"action":"solve","provider":"2captcha","task":{"type":"TurnstileTaskProxyless","websiteURL":"https://example.com","websiteKey":"observed-site-key"},"idempotency_key":"login-challenge-1","wait_ms":90000}
{"action":"wait","job_id":"returned-job-id","wait_ms":90000}
```

The provider catalog reports availability, missing keys/rates, credit units, rate version and official task documentation. After a ready result, apply the solution using the site's callback or fields, then verify that the website accepted it.

| Action | Behavior |
| --- | --- |
| `providers` | Discover configured providers and native task documentation. |
| `create_task` | Reserve credits and submit once; may return an immediate solution. |
| `get_result` | Retrieve/poll the existing job; never purchases another solve. |
| `wait` | Poll on the host, returning the current job at the deadline. |
| `solve` | Create/reuse and wait. |
| `push_variable` | Supply an AntiGate variable to a pending Anti-Captcha `AntiGateTask`. |

Wait defaults to 90 seconds and is capped at 120 seconds. Jobs survive browser tool calls and resumed leases of the same run. Separate run IDs have separate jobs. Reuse the job ID or the same idempotency key for the same challenge; a key with different input is rejected. Identical submissions already in flight are also reused.

Native task objects accept all provider task types and fields, rather than a fixed CAPTCHA enum. Full solution objects preserve tokens, text, coordinates, cookies and multi-field results. The optional `options.languagePool` supports `en`/`ru`; credentials, callback URLs and provider endpoints remain host-owned. Requests and responses are bounded at 2 MB. CapSolver's immediate `createTask` results are supported.

Statuses are `submitting`, `pending`, `ready`, `failed` or `uncertain`. A timeout or lost response during submission yields `uncertain`: the provider may have accepted the solve, so the job retains its credit reservation for operator reconciliation. Do not purchase a replacement automatically. Poll transport errors keep known provider jobs pending and pollable. Failed provider jobs return a sanitized error code and release their reservation.

## Configuration and billing

Set `CAPSOLVER_API_KEY`, `TWO_CAPTCHA_API_KEY` and/or `ANTI_CAPTCHA_API_KEY` on the engine, plus matching `SOLVER_RATES_JSON` entries. Keys alone do not enable paid submissions. The selected local rates are:

```json
[
  {"name":"capsolver","rateVersion":"solver-v1","creditUnits":1},
  {"name":"2captcha","rateVersion":"solver-v1","creditUnits":1}
]
```

Each job reserves its configured internal credits before contacting the provider. A ready result settles that charge exactly once, independently of the provider account's dollar charge. Insufficient internal balance prevents submission. Provider failure releases the reservation; uncertain submissions retain it. Anti-Captcha also requires a key and its own positive integer rate before use.

Web account initialization grants 1,000 internal credits once per verified Clerk login session. Refreshes, concurrent requests and server restarts with the same login do not repeat that grant. In permitted local mode without Clerk, the first web request grants 1,000 credits once per web-server process startup. Grants are additive ledger adjustments and do not reset balances or reservations.

Migration `0051_native_captcha_jobs.sql` stores run/account ownership, the provider task ID, request digest, rate, reservation and result. It does not store raw task inputs or provider keys. Calls check run leases and browser automation control. CAPTCHA request/result payloads and sensitive invocation source/output are omitted from SDK trace archives; provider solutions remain available to the Python caller and in the job row.

Compose forwards credentials and rates only to the engine. Rebuild the app and Python runner image, apply migrations, and recreate the engine when upgrading. The Tabductor runner extension injects `captcha` and registers its method allowlist.

## Website handling

The agent gathers observed parameters with Playwright, submits a native provider task, applies the actual solution and checks website acceptance. Native API coverage does not automatically detect or apply every CAPTCHA on every site. Tasks requiring a proxy/session/user agent must match the browser environment; do not silently substitute a proxyless task.

An explicitly rendered Turnstile widget may have neither a `.cf-turnstile[data-sitekey]` element nor a globally named callback. Inspect page scripts and, when necessary, capture `turnstile.render` options before rendering. Apply the captured callback or the actual site fields, including site-specific hidden fields. Use Camoufox's explicit `mw:` evaluation for application globals. Empty response fields mean an unfinished challenge, not proof that automation is impossible.

The agent-controlled browser path does not automatically request human takeover from legacy perception. Prompts require normal widget interaction or configured solver use before handoff. Missing inputs, unsupported challenges, funding/configuration errors, exhausted bounded attempts or a separate human authentication step can still justify handoff.

Integration coverage includes concurrent submission, restart/poll recovery, ambiguous requests, internal billing, missing rates/balance, run fencing, Python proxy calls, trace redaction, multiple cells and applying an explicit-render callback in real Camoufox. Provider responses in tests are mocked; tests do not buy live solves.

Official provider references checked 2026-09-24:

- [2Captcha task creation](https://2captcha.com/api-docs/create-task) and [task types](https://2captcha.com/api-docs)
- [CapSolver task creation and immediate results](https://docs.capsolver.com/en/guide/api-createtask/)
- [Anti-Captcha task creation](https://anti-captcha.com/apidoc/methods/createTask), [result retrieval](https://anti-captcha.com/apidoc/methods/getTaskResult) and [AntiGate variables](https://anti-captcha.com/apidoc/methods/pushAntiGateVariable)
