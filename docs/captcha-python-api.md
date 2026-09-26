# CAPTCHA services for browser Python

`workflow.captcha` exposes CapSolver, 2Captcha and Anti-Captcha through the host. Python continues using `playwright.sync_api` and the existing run-owned `page` and `context`. Provider credentials and outbound provider requests stay on the engine; Python needs no network access or API keys.

## API

```python
providers = workflow.captcha.providers()
job = workflow.captcha.solve(
    provider="2captcha",
    task={
        "type": "TurnstileTaskProxyless",
        "websiteURL": page.url,
        "websiteKey": observed_site_key,
    },
    idempotency_key="login-challenge-1",
    wait_ms=90000,
)
if job["status"] in ("pending", "submitting"):
    workflow.checkpoint.set(value={"captcha_job_id": job["id"]})
    # In this cell or a later cell, poll the same job:
    job = workflow.captcha.wait(job_id=job["id"], wait_ms=90000)
if job["status"] == "ready":
    token = job["solution"]["token"]
    # Apply the solution using the site's actual callback/fields with Playwright,
    # then verify that the website accepted it before proceeding.
```

`workflow.describe(name="captcha.solve")` exposes the input schema. The provider catalog reports availability, missing keys/rates, credit units, rate version and official task documentation.

| Method | Behavior |
| --- | --- |
| `providers()` | Discover configured providers and native task documentation. |
| `create_task(provider, task, idempotency_key, options?)` | Reserve credits and submit once; may return an immediate solution. |
| `get_result(job_id)` | Retrieve/poll the existing job; never purchases another solve. |
| `wait(job_id, wait_ms?)` | Poll on the host, returning the current job at the deadline. |
| `solve(provider, task, idempotency_key, options?, wait_ms?)` | Create/reuse and wait. |
| `push_variable(job_id, name, value)` | Supply an AntiGate variable to a pending Anti-Captcha `AntiGateTask`. |

Wait defaults to 90 seconds and is capped at 120 seconds. Jobs survive Python cells and resumed leases of the same run. Separate run IDs have separate jobs. Reuse the job ID or the same idempotency key for the same challenge; a key with different input is rejected. Identical submissions already in flight are also reused.

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

Compose forwards credentials and rates only to the engine. Rebuild the app and Python runner image, apply migrations, and recreate the engine when upgrading. The Python proxy must include the `captcha` method allowlist.

## Website handling

The agent gathers observed parameters with Playwright, submits a native provider task, applies the actual solution and checks website acceptance. Native API coverage does not automatically detect or apply every CAPTCHA on every site. Tasks requiring a proxy/session/user agent must match the browser environment; do not silently substitute a proxyless task.

An explicitly rendered Turnstile widget may have neither a `.cf-turnstile[data-sitekey]` element nor a globally named callback. Inspect page scripts and, when necessary, capture `turnstile.render` options before rendering. Apply the captured callback or the actual site fields, including site-specific hidden fields. Use Camoufox's explicit `mw:` evaluation for application globals. Empty response fields mean an unfinished challenge, not proof that automation is impossible.

The agent-controlled browser path does not automatically request human takeover from legacy perception. Prompts require normal widget interaction or configured solver use before handoff. Missing inputs, unsupported challenges, funding/configuration errors, exhausted bounded attempts or a separate human authentication step can still justify handoff.

Integration coverage includes concurrent submission, restart/poll recovery, ambiguous requests, internal billing, missing rates/balance, run fencing, Python proxy calls, trace redaction, multiple cells and applying an explicit-render callback in real Camoufox. Provider responses in tests are mocked; tests do not buy live solves.

Official provider references checked 2026-09-24:

- [2Captcha task creation](https://2captcha.com/api-docs/create-task) and [task types](https://2captcha.com/api-docs)
- [CapSolver task creation and immediate results](https://docs.capsolver.com/en/guide/api-createtask/)
- [Anti-Captcha task creation](https://anti-captcha.com/apidoc/methods/createTask), [result retrieval](https://anti-captcha.com/apidoc/methods/getTaskResult) and [AntiGate variables](https://anti-captcha.com/apidoc/methods/pushAntiGateVariable)
