# Amizone Turnstile investigation — 24 September 2026

Workflow: `wf_599acd9a-dfe0-4979-a1be-a34081f24f94`
Run: `run_0fd50d70-974b-4f99-b4e3-ed1c1c5005af`
Task: Complete Machine Learning Course

## Finding

The run is `awaiting_human`, not terminally failed. The quoted statement was supplied by the model to `workflow.human_action.request` (trace sequence 288), not returned by Cloudflare or a CAPTCHA provider. No solver attempt established that this challenge was unsolvable.

The associated session `session_d8e85a20-1209-4754-afa3-c80be0e85628` is now `ended`, with input ownership `paused`. Inspection was read-only; no credentials were submitted, no solve was purchased, and the run was not resumed.

## Evidence

- Trace 100 contains the site's inline `turnstile.render("#Capthcadiv", {sitekey: ..., callback: function(token) {...}})` initialization. Its callback assigns `#RecaptchaToken` and also updates `#_QString`.
- Trace 182 shows `#Capthcadiv` containing a hidden `cf-turnstile-response` input. The container lacks the `.cf-turnstile[data-sitekey]` attributes required by our detector.
- The model filled the supplied login details and waited five seconds. Token reads at 158 and 164 were empty. It first requested human action at 197 (10:05:48 UTC), claiming that the widget had not rendered and no challenge frame was available.
- After the run resumed, sequence 202 records another page perception. Sequence 224 identifies a Cloudflare Turnstile frame, and 233/239 still report empty CAPTCHA token fields. Cloudflare script/frame network entries include HTTP 200 responses. Missing iframe markup in a simple DOM query was not evidence that no challenge frame existed.
- At 288 (10:06:31 UTC), the model requested human assistance again with the exact message reported by the user. The current human-action row is pending.
- The trace's workflow API catalog contains 18 services, including human-action handoff, but no CAPTCHA solver service.
- `browser_challenges` has zero rows for this session, hence no linked `challenge_attempts` exist.
- The deployed engine container was started at 10:03:11 UTC, before this run. Its current environment has none of `CAPSOLVER_API_KEY`, `TWO_CAPTCHA_API_KEY`, or `ANTI_CAPTCHA_API_KEY`, and no `SOLVER_RATES_JSON`. The checked Docker Compose file does not pass these settings into the engine either. Configuration values were not exposed; only presence and rate metadata were inspected.

## Causes in the implementation

1. **No Python solver capability.** `packages/agent/src/python-tool.ts` exposes `workflow.human_action.request`, but not a CAPTCHA service. The proposed broader service in `docs/captcha-python-api.md` has not been implemented.
2. **No configured providers.** `apps/engine/src/main.ts:77` builds providers from `SOLVER_RATES_JSON`. An empty rates list produces zero providers, independently of page detection.
3. **Detection only runs on perception and expects declarative widgets.** `packages/engine/src/browser-hosted.ts:146` invokes recovery only when `page.perceive` returns a challenge. `apps/browser-worker/src/main.py:753` detects `.g-recaptcha[data-sitekey],.cf-turnstile[data-sitekey]`, which does not match Amizone's explicit-render container. Most of the agent's observations used native Playwright calls rather than the perception hook.
4. **Application also assumes a declarative callback.** `apps/browser-worker/src/main.py:735` requires a matching widget and a string `data-callback` naming a global function. Amizone supplies an inline callback to `turnstile.render`. Even if detection were repaired, the current generic application path would reject this observed markup. This is a code-path finding, not a failed solve observed in the run.
5. **Prompt encourages the conclusion.** The deployed `authentication-contract.ts` includes CAPTCHA among human-action blockers and instructs the agent not to bypass challenges. It does not instruct it to use configured solvers first. With no solver capability visible, the model generalized empty token fields into “cannot be completed programmatically.”

## Required correction

Wire configured provider credentials and rates into the deployment; expose durable provider-backed CAPTCHA operations to Python; support explicit Turnstile rendering and callback application; and update authentication guidance to attempt available solvers before requesting human intervention. Merely adding a key or changing the wording will not address all four integration gaps.

Empty response fields establish only that verification has not completed. Turnstile has a documented provider API for standalone widgets and render callbacks: [2Captcha Turnstile documentation](https://2captcha.com/api-docs/cloudflare-turnstile). This does not prove that a paid solve would succeed on this particular session; none was attempted.

## Configuration follow-up

The host `.env` contains nonempty CapSolver and 2Captcha keys. The missing credentials were specifically in the deployed engine container: Docker Compose omitted their environment mappings. The Compose file now forwards all three supported provider keys and `SOLVER_RATES_JSON` to the engine only; resolved configuration was checked without printing secret values. The host `.env` has no `SOLVER_RATES_JSON`, which is still required by the current provider-registration logic. Engine startup now reports configured keys whose providers lack rates. These source/configuration corrections have not been deployed and do not implement the missing Python solver service.

## Implementation follow-up (2026-09-24)

The Python CAPTCHA service is now implemented and deployed to the local engine, with migration 0051 and an updated Python runner image. CapSolver and 2Captcha both report available at 1 internal credit per solve under `solver-v1`; Anti-Captcha is supported but lacks local credentials/rates. Authentication prompts now require available automated solving before human handoff, and the agent-controlled perception path no longer forces legacy CAPTCHA takeover. See [Python CAPTCHA services](captcha-python-api.md).

Provider transport and billing tests passed, including a real Camoufox explicit-render callback flow using a mocked provider. No paid live solve was submitted and the affected run was not resumed as part of implementation. Earlier findings above describe the deployment at investigation time.
