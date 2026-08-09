# S6b — Trace consistency checker + compiler agent

You are implementing subphase S6b. Read, in order:
1. This file (authoritative).
2. `docs/techical_plan.md` — §11 (the whole compiler contract; the script artifact shown
   there is the **normative template** for what your agent must emit), §12 (the `ctx` API
   the emitted code targets), §17.2 (metric names).
3. `docs/impl-phases.md` — Phase 6 build steps 3–4 + the golden-compile/lint-corpus tests;
   §0.5 (instrument what you build).
4. `docs/graph-compilation-llm.md` — §2.4 (why the task selector must not say "never" for
   `kind=decision`) and §6.3 (content-hash keying, context only).
5. `docs/subphases/ROADMAP.md` — stack/style rules.

## Scope

Existing code to reuse (read first, match style): `packages/static-rt` (S6a isolate host —
your dry-run environment), `packages/compiler` (S6a script registry + lint gate — you extend
this package), `packages/agent` (S4a `Llm` adapter with `live|record|replay` — the compiler
agent is just another consumer of it), `trace_entries` shapes written by S3a/S4b (resolved
locators are already recorded per action — that was the point).

NOT yours: `CompiledExecutor`, deopt handoff, promotion/demotion counters, script
*activation* — all S6c. You produce `status=candidate` rows and stop. Also not yours:
any change to the sandbox or lint gate themselves (S6a owns them; you only call them).

## Deliverables — in `packages/compiler`

1. **Trace consistency checker** (`consistency.ts`):
   `checkConsistency(traces: RunTrace[]) → ConsistencyReport`.
   - Input: K successful `ai`-mode traces for one task (K=2 default — the §11 promotion
     prerequisite; a single trace overfits A/B variants and one-time banners).
   - Verifies across all K: same navigation sequence, same ordered action kinds, same
     **resolved locator** per corresponding step (strategy + selector as recorded in the
     trace), extraction steps pull from the same anchors, emitted event types match.
   - Output on success: `{ consistent: true, anchors, waits, extractions, emits }` — the
     stable anchor set (locator + strategy per step), max observed wait per step, extraction
     shapes, and emitted packet shapes. This object is the compiler agent's input.
   - Output on failure: `{ consistent: false, reason }` with a human-useful reason
     ("step 4 locator diverged: `[data-testid=tweet]` vs `article.tweet`"). No
     `compiled_scripts` row is created; the reason is logged (structured, with task_id)
     and returned to the caller — S6c's promotion loop reads it.

2. **Compiler agent** (`compile.ts`): `compileTask(deps, taskId, traces) → CompileResult`.
   - Uses the S4a `Llm` adapter (`live | record | replay` — CI runs replay only). Prompt =
     consistency report + trimmed traces + the §11 template with its rules stated: guard
     block first (`ctx.guard.url/exists/noDialog` distilled from what every trace saw);
     static path via `ctx.page.*` + declarative `evalExtract` only; `ctx.emitIfNew` with
     the task's dedupe key; `ctx.state` for cursors; `ctx.deopt(recoveryPrompt, evidence)`
     wherever a §11 deopt-trigger class applies (guard failure, zero-extraction where
     traces always saw data). The recovery prompt must restate the task goal and expected
     emit schema — it is what the agent wakes up to mid-run in S6c.
   - **Validation pipeline, in order, before any row is written:** (a) S6a lint gate (AST:
     no `eval`/`Function`/imports/`with`; only `ctx.*` member calls); (b) **dry-run in the
     S6a sandbox** against a fixture replay session — the script must complete or deopt
     cleanly, not throw. Only then insert `compiled_scripts` with `status='candidate'`,
     `from_runs` provenance, and version = prior max + 1. Any pipeline failure → no row,
     descriptive error in the result.
   - **Task selector: `kind = 'browser'` only.** Write the filter with a comment that
     `decision` joins the list when `ctx.store` lands in the static runtime
     (graph-compilation-llm §2.4) — the list is intentionally not `!= 'asset'`.
   - Telemetry (§0.5): `compile_runs_total` counter; the whole compile wrapped in a span
     with task_id attribute and duration.

3. **System tests** (`tests/system/`, content-named, e.g. `trace-consistency.test.ts`,
   `compiler-agent.test.ts`):
   - Consistency accept: two replay-driven fake-tweets runs → report with anchors/waits;
     deterministic across orderings of the input traces.
   - Consistency reject: one trace against `mutator?layout=v1`, one against `?layout=v2`
     → `consistent: false`, reason names the diverging step; no `compiled_scripts` row.
   - **Golden compile:** recorded compiler transcript over the canonical fake-tweets traces
     → emitted script snapshot-tested (normalize whitespace/version comments); script passes
     lint and dry-run; `candidate` row exists with correct `from_runs`.
   - Lint rejection corpus (table-driven): `eval`, `new Function`, `import`, `with`,
     non-`ctx` member calls, top-level `fetch` — each rejected, no row created. Extend the
     table whenever someone thinks of a new escape.
   - Dry-run failure: a hand-written script that throws mid-path → pipeline fails, no
     candidate row.
   - **Kind filter:** an `asset` task with K clean runs is NOT compiled; a `decision` task
     is NOT compiled (yet). These guard the §4 boundary — a silently widened selector would
     put MCP calls behind guards that cannot assert on them.

## Style constraints (binding)
- The checker is pure functions over trace data — no classes, no DB access inside it
  (callers load traces).
- The compiler agent is one function composing existing pieces (Llm, lint, sandbox,
  registry). No "CompilerService".
- New deps: none. The sandbox, lint, and Llm adapter all exist.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests stay green; run twice (replay transcripts must be deterministic).

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Do NOT git commit.
