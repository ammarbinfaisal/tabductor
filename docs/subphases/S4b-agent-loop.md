# S4b — Agent loop, tool registry, AgentExecutor (the browser node goes live)

You are implementing subphase S4b. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 4 (tool registry, agent loop, structured emit bullets) and
   §0.5 (telemetry rules).
3. `docs/techical_plan.md` — §4 (browser node tool list), §9 steps 2–3 (network tools),
   §16 Threat 1 (content demarcation).
4. `docs/subphases/S4a-llm-perception.md` and `S3b-pool-network-limits.md` — you compose
   what they built; their interfaces are binding.
5. `docs/subphases/ROADMAP.md`.

Existing code to reuse (read first): `packages/agent` (S4a: `Llm` adapter with
live/record/replay, `buildPerception` with anchor→locator maps), `packages/browser`
(`openRunSession`, `session.network.list/body`, trace recorder), `packages/engine`
(executor contract, run state), `packages/bus` (emit + dedupe `claim`), `packages/telemetry`
(SOb: meter/logger by injection). Policy is `AllowAllGate` — tool SHAPES are final in this
subphase; Phase 7 changes verdicts, never signatures.

## Scope

The LLM-driven browser agent: tool registry, loop, `AgentExecutor`. The perception builder
and LLM adapter are S4a — consume, don't modify (extend only if an interface is genuinely
missing, and say so in the report). MCP, assets, secrets do not exist on this node, ever
(§4 registry boundary). The compiler is Phase 6.

## Deliverables (extend `packages/agent`)

1. **Tool registry** (`tools.ts`) — the browser node's LLM-facing tools, each a zod-typed
   definition + an executor closure over the run session:
   - `page.goto(url)`, `page.click(anchor)`, `page.type(anchor, text)`, `page.scroll(dir)`,
     `page.waitFor(anchor | text, {timeoutMs})`, `page.extract(anchor?, fields)` — anchors
     are S4a perception ids; every action re-records the resolved locator in the trace.
     After each mutating action, return a fresh perception summary as the tool result.
   - `network.list({urlPattern?, limit?})` — thin wrapper over `session.network.list`
     (§9 step 2 truncation included in the tool result).
   - `network.read(index, parts)` where `parts ⊆ {request_body, response_body,
     request_headers, response_headers}` (§9 step 3). Body parts wrap
     `session.network.body`; add header capture to the session/driver if S3b did not record
     them (observer-side, traced). Each part passes `PolicyGate.checkNetworkRead`
     (permissive now — the per-part gating point must exist so Phase 7 is a policy change).
   - `emit(type, packet, {dedupeKey?})` — see deliverable 3.
   - `done(result)` / `fail(reason)` — terminate the loop.
   Registry is a data structure (`ToolDef[]`) the executor filters and hands to the `Llm`
   adapter — S7 will remove un-granted tools from this list; build it as a list, not a
   switch.

2. **Agent loop** (`loop.ts`): `runAgentLoop({llm, session, task, triggerPacket, trace, budget})`.
   System prompt assembled from, in order: the task prompt; the trigger event's packet
   fields injected as named variables **per the emitting node's declared schema** (event_defs);
   the task's declared emit event types + packet schemas ("what you may emit"); tool docs.
   Perception text and packet values are wrapped in explicit data delimiters and labelled
   as untrusted content (§16 Threat 1d — helps, never load-bearing). Loop: perception →
   `llm.complete` → execute tool calls → append results → repeat. Step budget from
   `limits_json.agent.max_steps` (default 30) enforced in the loop → run fails
   `step_budget_exceeded`; the run-level timeout stays engine-side (S2a watchdog), no
   duplicate timer here. Every LLM call → trace entry (prompt hash, usage, tool-call
   summary — S4a adapter already does this when given the recorder).

3. **Structured emit**: `emit` validates the packet against the node's `event_defs` schema
   (ajv) BEFORE publishing. Invalid → the validation error is returned as the TOOL RESULT
   (not a run failure) so the model corrects within its step budget; valid → outbox publish
   with `causation_id` = trigger event. `dedupeKey` routes through the bus side-effect
   dedupe (`emitIfNew` semantics, §6). Emitted events → trace.

4. **`AgentExecutor`**: composes 1–3 behind the engine's executor contract; registered for
   mode `ai` (S5a re-keys the registry to `(kind, mode)`; this becomes `(browser, ai)` —
   leave a comment, don't pre-build the kind key). Acquires the browser session via S3b's
   pool/lease path like any other executor.

5. **Telemetry** (impl-phases §0.5, binding names): `llm_tokens_total{model,direction}` and
   `llm_cost_usd_total{model,kind,mode}` (price table per model in config, one place),
   counted in the adapter call path via the injected meter. No content in telemetry.

6. **System tests** (`tests/system/`, content-named; replay transcripts checked into
   fixtures — record them once with `record` mode against live, then commit):
   - Canonical flow (replay): fake-tweets → goto → extract → `emit tweet.detected` ×3 with
     dedupe keys → downstream stub task receives all three packets; trace shows LLM calls
     with prompt hashes and resolved locators.
   - Network tools (replay): agent calls `network.list` then `network.read(response_body)`
     on the timeline XHR → body content visible in the next LLM request; read traced.
   - Emit validation retry (replay): one malformed emit, tool result carries the ajv error,
     corrected emit succeeds → run succeeds, exactly one downstream trigger.
   - Step budget: transcript that never calls `done` → `step_budget_exceeded` at
     `max_steps`, run failed, trace intact.
   - **First end-to-end milestone (replay, CI):** fake-tweets (cron, agent) →
     `tweet.detected` → second agent task posts to fake-gram; scheduler re-fire re-runs the
     first task and `emitIfNew` dedupe prevents any double-post (assert fake-gram
     submission count).
   - **Live-eval suite** (`tests/live-eval/`, excluded from the CI project; skipped without
     `ANTHROPIC_API_KEY`): same fixtures in `live` mode, asserting OUTCOMES only (correct
     events emitted, post landed) — never exact action sequences.

## Style constraints (binding)
- The loop is one function; no agent framework, no planner/reflection layers, no
  conversation-manager class. Tool defs are data + closures.
- No new deps expected (`@anthropic-ai/sdk` arrived in S4a). Justify anything you add.
- Registry must contain no `mcp.*`, `assets.*`, or `store.*` names — S5c adds the test
  asserting this, but violating it here is a design-doc breach (§4).

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests stay green; run twice. Replay tests must pass with no network access and no
API key set.

## Report back
What you built, deviations + why, which transcripts you recorded and how, commands +
outcomes, flakiness noticed. Do NOT git commit.
