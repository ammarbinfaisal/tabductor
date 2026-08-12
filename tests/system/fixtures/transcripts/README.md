# S4b replay fixtures

JSONL, one line per `Llm.complete` turn, read by `packages/agent/src/transcript.ts`'s
`replayLlm`. `__FX_URL__` is a literal token the test rig (`tests/system/agent-support.ts`)
substitutes with the fixture server's real (randomized) origin before use — the files
themselves never bake in a port.

| File | Provenance |
|---|---|
| `canonical-fake-tweets.jsonl` | Hand-authored. A `record` attempt against live OpenAI (`gpt-5.2`) succeeded end-to-end (7 turns, correct emits), but the recorded transcript issued `page.extract` immediately after `page.goto` with no `page.waitFor` in between — safe live, where the round trip to the model gives the page's async XHR time to settle, but a replay race under `replayLlm` (near-zero latency between tool calls) resolves the tweet anchors before they exist. Hand-authored with an explicit `page.waitFor({text: "permalink"})` after `goto` instead. |
| `network-tools.jsonl` | **Recorded** against live OpenAI (`gpt-5.2`), kept as recorded — the model's own turn included `page.waitFor` before touching the network tools, so it replays cleanly with no race. |
| `emit-validation-retry.jsonl` | Hand-authored by design, not as a fallback: the scenario is "submit a packet you already know is invalid, on purpose" — not a task a live model can be prompted into naturally without the prompt itself giving away the answer, which would test the prompt, not the loop's retry path. |
| `step-budget.jsonl` | Hand-authored by design: the scenario is "never call `done`" — asking a live model to do that is asking it to behave adversarially against its own task, which produces exactly nothing reproducible. |
| `milestone-scrape.jsonl`, `milestone-poster.jsonl` | Hand-authored by design: the milestone's assertion is about `emitIfNew` dedupe across two runs of the *same* script — the fixtures must be byte-identical across the two fires for the property under test (not the model's creativity) to be what's being exercised. |

All six fixtures are also each independently valid tool-call sequences a real model would
plausibly issue — a hand-authored fixture is not a fake one, it is a deterministic control
input to the loop, on the same principle `ScriptedBrowserExecutor` (S3b) uses for the engine.

## S5c: asset-node fixtures (`mcp-*.jsonl`)

| File | Provenance |
|---|---|
| `mcp-echo.jsonl` | Hand-authored. No `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` was available in this environment to record against, so this is a control input, not a fallback — but the scenario ("call the one configured MCP tool, then finish") is also exactly the kind `network-tools.jsonl` shows a live model reaches for naturally when recording is available. |
| `mcp-budget.jsonl` | Hand-authored by design, `step-budget.jsonl`'s precedent: the scenario is "call the same tool more times than the budget allows, on purpose" — not a task a live model can be prompted into without the prompt giving away the answer, which would test the prompt, not the budget check. |
| `mcp-timeout.jsonl` | Hand-authored by design: the scenario needs the fake server's `sleep` tool to run longer than a short, test-configured `call_timeout_ms` — a live model has no way to know that number, so nothing about "wait for a tool that's too slow" is naturally promptable. |
| `mcp-credential.jsonl` | Hand-authored: a harmless `echo` call plus `done`, reused verbatim by both the credential-hygiene test and its negative control — the fixture asserts nothing about credentials itself, only the server-side gate and the broker wiring around it do. |

## S5f: two-kind e2e fixtures (`two-kind-*.jsonl`)

No `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` was available in this environment either (same
situation `mcp-echo.jsonl` and its siblings document above), so all three are hand-authored
control inputs, not recordings — each is still a plausible sequence a real model would issue
for its task, on the same "a hand-authored fixture is not a fake one" principle this file
opens with.

| File | Node / task | Provenance |
|---|---|---|
| `two-kind-scrape.jsonl` | browser, `Scrape` | Hand-authored: `goto` → `waitFor("permalink")` → `extract` → `emit tweet.detected` (one tweet only, `t1`) → `done`. Deliberately narrower than `canonical-fake-tweets.jsonl`/`milestone-scrape.jsonl` (which emit all three fixture tweets) — one tweet keeps the downstream render/upload count in this e2e at exactly one, which is what the byte-match and dedupe assertions want to reason about. |
| `two-kind-report.jsonl` | asset, `Report` | Hand-authored: `mcp.fake.imageStub` → `assets.write` (a `.tex`, mirroring `apps/renderer/sandbox/warmup/warm-article.tex`'s package set — a bare `\textit{...}` needs an italic Latin-Modern font metric the `--only-cached` sandbox never pre-warms, discovered the hard way) → `assets.render` → `emit report.ready`. The `emit` call's `packet` ships a placeholder asset ref (`PLACEHOLDER`/`PLACEHOLDER`/…) — `two-kind-e2e-support.ts`'s `spliceRealAssetRef` wrapper replaces it with the *real* `assets.render` output before the call ever leaves the process, because neither `asset_id` (fresh per write) nor `sha256` (S5e's renderer is not byte-stable across separate compiles, `apps/renderer/src/sandbox.ts`'s own comment on `-Z deterministic-mode`) can be hardcoded into a static transcript file. A live model would read the identical tool-result text (already in its own context, per `loop.ts`'s `untrustedBlock("tool results", …)`) and copy the same values by hand; the wrapper is the deterministic stand-in for that one copy. |
| `two-kind-upload.jsonl` | browser, `Upload` | Hand-authored: `goto __FX_URL__/fake-gram` → `page.upload` (anchor `e9`, the fixture's upload `<input type="file">`) with an `assetRef` templated as `__ASSET_ID__`/`__ASSET_PATH__`/`__ASSET_MIME__`/`__ASSET_SHA256__` (substituted from the run's actual `report.ready` event, read back out of the DB — the same `__FX_URL__` substitution convention `agent-support.ts` uses for the fixture server's random port, extended to four more tokens) → `page.click` (anchor `e10`, the submit button) → `done`. |
