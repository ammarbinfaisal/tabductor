# Repeated Amizone CAPTCHA handoff — 24 September 2026

Workflow: `wf_599acd9a-dfe0-4979-a1be-a34081f24f94`
Run: `run_ceaffccb-523a-4221-882b-55545ea58365`

The run reproduced the previously diagnosed integration gaps. The engine container was rebuilt/restarted at 10:20:57 UTC, but the relevant solver capability, configuration and authentication guidance are unchanged.

## Observed sequence

- Run started at 10:21:38 UTC.
- The only `perceive` trace entry is sequence 2, on `about:blank`. Subsequent page inspection used native Playwright operations. The existing host solver hook runs on `page.perceive`, not those native operations.
- The agent navigated to Amizone, inspected inputs and frames, and captured a screenshot. The trace contains no Playwright `click`, checkbox check or mouse click operation. It did not attempt an ordinary challenge interaction.
- At sequence 528, 10:22:32 UTC, the model called `workflow.human_action.request`, asserting that the visible CAPTCHA requires human completion.
- Current run status is `awaiting_human`. The associated session `session_591107ff-fc2e-4307-a83a-c5afc317f223` is still `running` at inspection time, unlike the previous run's ended session.

## Confirmed unchanged gaps

1. The deployed engine environment has no CapSolver, 2Captcha or Anti-Captcha API key and no solver rate configuration. The configured provider list is empty.
2. The trace lists 18 workflow services and no CAPTCHA solver service. Inspection of the deployed `python-tool.ts` also confirms the proposed solve/provider catalog functions are absent.
3. There are zero browser challenge rows for this execution and zero provider attempts.
4. The deployed authentication guidance still names CAPTCHA as a human-action blocker and tells the agent not to bypass challenges. It does not tell the agent to attempt available automated solving first.
5. The earlier report identified an additional Amizone-specific mismatch: explicit `turnstile.render` initialization and an inline callback do not match our declarative-widget detector/application logic. In this new run, the perception hook was not invoked after navigation in the first place.

The earlier investigation and Python CAPTCHA API proposal did not implement or deploy the solver integration. A new build/rerun therefore still follows the same path. Changing only the model wording or restarting the container does not supply the absent solver capability or provider configuration.

This investigation was read-only apart from this report. No paid solver request, page interaction, run resume or deployment was performed.

## Configuration follow-up

The host `.env` contains nonempty CapSolver and 2Captcha keys. The missing credentials were specifically in the deployed engine container: Docker Compose omitted their environment mappings. The Compose file now forwards all three supported provider keys and `SOLVER_RATES_JSON` to the engine only; resolved configuration was checked without printing secret values. The host `.env` has no `SOLVER_RATES_JSON`, which is still required by the current provider-registration logic. Engine startup now reports configured keys whose providers lack rates. These source/configuration corrections have not been deployed and do not implement the missing Python solver service.

## Implementation follow-up (2026-09-24)

The Python CAPTCHA service is now implemented and deployed to the local engine, with migration 0051 and an updated Python runner image. CapSolver and 2Captcha both report available at 1 internal credit per solve under `solver-v1`; Anti-Captcha is supported but lacks local credentials/rates. Authentication prompts now require available automated solving before human handoff, and the agent-controlled perception path no longer forces legacy CAPTCHA takeover. See [Python CAPTCHA services](captcha-python-api.md).

Provider transport and billing tests passed, including a real Camoufox explicit-render callback flow using a mocked provider. No paid live solve was submitted and the affected run was not resumed as part of implementation. Earlier findings above describe the deployment at investigation time.
