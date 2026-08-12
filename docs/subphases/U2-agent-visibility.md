# U2 — Agent visibility

> **Built as specified, with the deviations noted inline below and summarized at the end.**
> No prompt file existed for this slice — the orchestrator's task prompt *was* the spec, and
> this document is that spec rewritten in the house `docs/subphases/SNN-*.md` shape, folded
> together with what actually shipped (`U1.5-run-inspector.md`'s own pattern, one slice ago).

You are implementing UI-track slice U2. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — the UI track table (U2 row) and its two standing rules. The row's
   parenthetical ("prompts, token counts, tool-call sequences") needs the correction argued in
   deviation 1 below before it can be read literally.
3. `docs/subphases/U1.5-run-inspector.md` and `S4b-agent-loop.md` — the run inspector's row
   idiom and what S4b actually writes to a run's trace, both binding as-built records.
4. Existing code: `apps/web/src/components/run-inspector.tsx`, `apps/web/src/server/routers/run.ts`
   (`run.trace`, `run.get`), `packages/agent/src/llm.ts` (`withTrace`), `packages/agent/src/executor.ts`
   (`makeEmitFn`), `packages/agent/src/pricing.ts`, `apps/web/src/components/event-feed.tsx` (the
   `?event=` linking convention), `apps/web/src/app/globals.css` (Ruled Ink tokens).

## Scope

The inspector gains LLM-call visibility and emitted-packet views, extending U1.5's trace
timeline rather than forking it — `kind: "llm"` rows already exist in the `TRACE_KINDS` enum
and already have a placeholder case in `TraceSummary`; `action` rows with `payload.action ===
"emit"` already flow through the same `run.trace` procedure U1.5 built. Packet-schema
authoring is explicitly **not** this slice — it shipped at EC1/U1, on the event rather than the
emitting node.

## Deliverables

1. **`llm` trace rows get a first-class rendering**, visually distinct from action rows: a
   truncated prompt hash (full hash in the existing collapsible raw-payload `<details>`),
   `in→out` token counts, the tool-call sequence as chips in call order, and cumulative token
   totals for the run in the header for mode `ai` runs.
2. **Emitted-packet views**: `action:"emit"` rows render the event type, dedupe state
   (`deduped: true` → "deduped — not republished"), ok/error, and a link to the event when
   `eventId` is present. A rejected emit (`ok:false`) renders its validation error readably.
3. **Run header**: for mode `ai` runs, step count and cumulative tokens; cost only if the
   payload actually carries a model name (see deviation 2 — it does not, so no cost estimate
   ships).
4. **No backend changes expected** — `run.trace` already serves every row generically, and
   `run.get` already carries `modeUsed`. Extend only if a genuine gap is found, with a system
   test.
5. **Docs**: this file; a U2 row on `ROADMAP.md`.

## Style constraints (binding)

- Ruled Ink tokens only, no raw colors — extend U1.5's `.trace-row` system, don't fork it.
- Hook policy held: no hooks beyond `useMountHook`/`usePolling`/`useStoreBridge`; the existing
  per-run vanilla store, not a new one.
- No new dependencies. No UI tests (doctrine).

## Verification

```
pnpm install && pnpm build && pnpm lint && pnpm test
```
Full suite green twice (168 tests, 43 files, 1 skipped keyless — no new tests, since no backend
changed). `next build` in `apps/web` green.

## Report back

What was built; whether a backend addition was needed; what the `llm` payload actually carries
and what could therefore be rendered; deviations; exact test counts both runs; flakiness.

---

## As built

Everything landed in two files: `apps/web/src/components/run-inspector.tsx` and
`apps/web/src/app/globals.css`. **No backend diff** — `run.trace` (U1.5) already returns every
row generically by `{seq, kind, payloadJson, blobRef, createdAt}`, `kind: "llm"` was already in
`TRACE_KINDS`, and `run.get` already returns `run.modeUsed`. The likely case the task prompt
named turned out to be the actual case.

**`llm` rows** (`LlmSummary`): a truncated `prompt_hash` (`slice(0, 12)` + `…`, full hash still
one `<details>` click away in the row's existing raw-payload dump, unchanged from U1.5), `in→out`
token counts, and the `tool_calls` array rendered as `.chip--tool` chips in call order — reusing
the neutral surface/border/text-secondary triple `.chip--schedule` already established, since a
tool call is neither an event nor a node entity and doesn't belong in either entity-family ramp.
The row itself (`.trace-row--llm`) gets a left border + background in the accent family
(`--accent-solid` / `--accent-bg-subtle`) — deliberately not the error family U1.5 reserved for
`.trace-row--denied` ("look here, something's wrong"); this is "look here, the model's turn",
a different claim, so it needed its own color reservation rather than reusing the one the
product already committed to a specific meaning.

**Emit rows** (`EmitSummary`, inside the existing `action` case): an `EventChip` (the same
`◈ {type}` primitive `event-feed.tsx`/the node panel already use) for the event type, then one of
three states read directly off `executor.ts`'s `makeEmitFn` payload shapes — `deduped: true` →
"deduped — not republished"; `ok: true` with `eventId` → a link to
`/workflows/{workflowId}/events?event={eventId}`, the exact convention the inspector's own
trigger link already used before this slice (`event-feed.tsx`'s `initialKey` prop opens the
lineage view at that event); `ok: false` → `payload.error` rendered in `--status-failed` ink
(`.trace-emit-error`), which is already `ajv.errorsText(...)` output from `packet-schema.ts` —
human-readable text, nothing to reformat. No special "pairing" logic connects a rejected emit to
the `llm` row that follows it; the story reads from the timeline's natural order, the same way
U1.5's failure-detail lookup reads the timeline rather than annotating rows with cross-references.

**Run header**: for `run.modeUsed === "ai"`, one line — "`N` llm steps loaded · `X→Y` tokens
in→out" — computed client-side by `llmStats`, a fold over `state.trace` identical in spirit to
`findFailureDetail`'s scan and carrying the same "as loaded" honesty (a run whose `llm` rows
haven't all been paged in under-reports until "Load more" is clicked; no extra caveat text was
added beyond what the existing failure-detail feature already established as this app's idiom
for partial-data displays).

## Deviations, argued

1. **The impl-phases U2 row's "prompts" never meant prompt text, and this file says so on the
   record.** The row reads "Inspector gains LLM calls (prompts, token counts, tool-call
   sequences)". `techical_plan.md` §8 and `S4a-llm-perception.md`/`S4b-agent-loop.md` both
   specify that a trace entry records a prompt **hash**, never the prompt itself — content
   rules (§16 Threat 1) forbid it, and `packages/agent/src/llm.ts`'s `withTrace` confirms it in
   code: the one thing hashed and stored is `{prompt_hash, usage:{in,out}, tool_calls:[names]}`.
   Prompt text exists only in the record-mode fixtures under
   `tests/system/fixtures/transcripts/` — replay/test artifacts, never anything the trace or
   this UI touches. Read "prompts" in the row as shorthand for "the LLM call's identity" (which
   *is* the hash) rather than as a literal instruction to surface prompt bodies; this slice
   renders the hash, truncated, with the full value one click away — the correction the task
   prompt itself anticipated and asked to have recorded here.

2. **No cost estimate ships, because no trace row carries a model name.** The task prompt's own
   framing turned out to match the code exactly: `packages/agent/src/pricing.ts`'s `costUsd`
   needs a `model` string to look up a price, and `withTrace`'s recorded payload has no such
   field — `withMetrics` (the sibling wrapper) *does* know the model, because `createLlm`
   resolves it before either wrapper runs, but that number goes to `llm_cost_usd_total`
   (telemetry, S4b deliverable 5), not to the trace row this UI reads. Adding a model field to
   the trace payload to make a UI-side cost estimate possible would be an S4b surface change
   made from inside a UI slice — explicitly out of scope per the task prompt, and not attempted.
   Token totals alone are rendered instead, which is what the payload actually supports.

3. **The `llm` row's distinct styling reuses the accent/event-family tokens, not a new pair.**
   The brief asked for something "visually distinct... this is the 'the model thought here'
   row" without naming a token. `--accent-solid`/`--accent-bg-subtle` were already in the
   palette and already carry a "calm, informational" connotation in this app (`HealthStamp`'s
   "healthy" state in U1.5 reasoned the same way about the sibling ink-blue/amber pair). Adding
   a bespoke color for one row kind would be new palette surface against a design doc that says
   "tokens only, no raw colors" and, more specifically, "extend, don't fork" the row system —
   reusing an existing semantic token, applied to a new selector, is the extension; a new token
   would have been the fork.

4. **No new system test.** Deliverable 4 was "no backend changes expected... if a genuine gap
   is found, extend minimally with a system test" — no gap was found. `run.trace` already
   returns `kind: "llm"` and `kind: "action"` rows with no filtering by shape, and `run.get`
   already returns `modeUsed`; U1.5's own three system tests (seq ordering, cursor paging, the
   `ws_url` absence assertion) remain the entire backend contract this UI renders against,
   unchanged. This UI slice's only tests are, per doctrine, none.
