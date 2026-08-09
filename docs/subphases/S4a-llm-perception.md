# S4a — LLM adapter (live/record/replay) + perception builder

You are implementing subphase S4a. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 4 (perception builder, LLM adapter bullets) + the
   "LLM replay adapter" paragraph in the test-infrastructure section.
3. `docs/techical_plan.md` — §8 (agent perception model), §16 threat 1 (why raw HTML is
   excluded).
4. `docs/subphases/ROADMAP.md`.

Existing code to reuse (read first): `packages/browser` (driver `Page`, `openRunSession`,
trace recorder), `packages/core` (config has `ANTHROPIC_API_KEY`), testkit fixture sites.
The agent LOOP (tool registry, system prompt, tool-call cycle) is S4b — NOT yours. You are
building the two inputs it composes: what the model sees (perception) and how the model is
called (adapter).

## Deliverables — new package `packages/agent`

1. **LLM adapter** (`llm.ts`): one interface
   `Llm = { complete(req: LlmRequest): Promise<LlmResponse> }` where `LlmRequest` is
   `{ system, messages, tools }` (typed tool defs with zod-validated JSON Schema params)
   and `LlmResponse` is `{ text?, toolCalls: [{id, name, args}], usage: {in, out} }`.
   Three implementations:
   - `liveLlm({apiKey, model})` — Anthropic Messages API via `@anthropic-ai/sdk`; model
     default `claude-sonnet-5`; retries 429/5xx with backoff (SDK's built-in retry is fine).
   - `recordLlm(inner, fixturePath)` — delegates to `inner`, appends each request/response
     pair (full JSON) to a transcript fixture file.
   - `replayLlm(fixturePath)` — serves recorded responses in sequence; asserts the request
     "shape" matches the recording (same tool names available, same message count) and
     throws a descriptive error on divergence — a drifted replay must fail loudly, not
     hallucinate. Transcript format: JSONL, zod-validated on load.
   Factory `createLlm(mode, opts)` selects by `"live" | "record" | "replay"`.
   Every call (all modes) records prompt hash, token usage, and tool-call summary to the
   trace when a trace recorder is provided.

2. **Perception builder** (`perception.ts`): `buildPerception(page, opts) → Perception`
   where `Perception = { url, title, elements: AnchoredElement[], text: string }`:
   - Elements: interactive/salient nodes (links, buttons, inputs, [data-testid], headings,
     articles) each with a stable **anchor id** (`e1`, `e2`, …) the runtime can resolve back
     to a locator — keep an anchor→locator map on the session; the TRACE records the
     resolved locator whenever an anchored element is acted on (the compiler consumes this
     in S6). Prefer test-ids > roles+accessible-name > text > css-path as locator strategy,
     in that order, recorded per element.
   - Text: page main-text extraction, token-budgeted (`opts.maxChars`, default ~8k chars)
     with truncation markers. NO raw HTML in the output (§16 threat 1).
   - Implementation: one `page.evaluate`-style driver call is acceptable here (the driver
     may need an internal `extractPerception()` method — implement it inside
     `packages/browser`'s playwright impl, NOT as arbitrary page-JS from the agent side;
     the §12 "no arbitrary evaluate" rule constrains generated/agent code, not our own
     runtime).
   - Determinism: same fixture page → same anchor assignment (sort by document order).

3. **Tests**
   - Unit (`packages/agent`): replay adapter — divergence detection (different tool set,
     exhausted transcript) throws with a useful message; record→replay round-trip on a
     stubbed inner Llm.
   - System (`tests/system/`, content-named): perception on fake-tweets — ≥3 tweet
     articles anchored, anchors resolve back to locators that `click`/`queryAll` accept,
     test-id strategy chosen where available, text budget respected on a long page
     (slowpoke or an added long fixture), no `<` HTML tags in `text`.
   - Live-mode smoke behind `ANTHROPIC_API_KEY` guard (skipped when unset — CI never
     calls live): one trivial completion, records a transcript to a temp dir, replays it.

## Style constraints (binding)
- The adapter is three small functions behind one interface — no provider-abstraction
  layer for hypothetical non-Anthropic models.
- Perception is data assembly, not a framework: one builder function + types.
- New deps: `@anthropic-ai/sdk` only.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests stay green; run twice.

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Do NOT git commit.
