# S6b — Trace consistency checker + compiler agent

**Status:** done, then **superseded in part by S6e**. The contract is
[trace-compilation.md](../trace-compilation.md); full-trace interpretation, the plan gate and
isolated validation landed in [S6e](S6e-post-execution-compilation.md), which deleted this
subphase's `consistency.ts`. The notes below describe what S6b itself shipped.

You are implementing subphase S6b. Read, in order:
1. `docs/trace-compilation.md`, then this subphase's requirements.
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

1. **Trace interpretation and consistency:**
   - Input: a completed successful trace (**K=1**), the detailed internal task prompt,
     trigger and event contracts; additional successful traces when available.
   - The compiler LLM separates DOM exploration, probing and abandoned attempts from the
     actual work. Required navigation, extraction, business actions, events and state
     behavior become an explicit reusable plan grounded in the evidence.
   - Deterministic checks evaluate that plan and its assumptions. When several traces are
     available, compare the distilled work; different exploratory sequences are not by
     themselves a refusal reason. Preserve source-run provenance and explain refusals.
   - The current `checkConsistency` API compares reduced raw action sequences before the
     LLM. It is an implementation gap, not the intended semantic interpretation stage.

2. **Compiler agent** (`compile.ts`): `compileTask(deps, taskId, traces) → CompileResult`.
   - Runs as a separate post-execution task, using the S4a `Llm` adapter
     (`live | record | replay` — CI runs replay only). It receives full available trace
     evidence and task context, distills the work, then emits the §11 script: guard
     block after required initial navigation and before dependent work
     (`ctx.guard.url/exists/noDialog` grounded in the traces);
     static path via `ctx.page.*` + declarative `evalExtract` only; `ctx.emitIfNew` with
     the task's dedupe key; `ctx.state` for cursors; `ctx.deopt(recoveryPrompt, evidence)`
     wherever a §11 deopt-trigger class applies (guard failure, zero-extraction where
     traces always saw data). The recovery prompt must restate the task goal and expected
     emit schema — it is what the agent wakes up to mid-run in S6c.
   - **Validation pipeline, in order, before any row is written:** (a) S6a lint gate (AST:
     no `eval`/`Function`/imports/`with`; only `ctx.*` member calls); (b) **dry-run in the
     S6a sandbox** against fixture/replay or otherwise isolated inputs. Demonstrate the
     work on representative inputs and a clean deopt when assumptions fail; a deopt alone
     is not proof that the work succeeds. Validation must not repeat live side effects.
     Only then insert `compiled_scripts` with `status='candidate'`,
     `from_runs` provenance, and version = prior max + 1. Any pipeline failure → no row,
     descriptive error in the result.
   - **Task selector: `kind = 'browser'` only.** Write the filter with a comment that
     `decision` joins the list when `ctx.store` lands in the static runtime
     (graph-compilation-llm §2.4) — the list is intentionally not `!= 'asset'`.
   - Telemetry (§0.5): `compile_runs_total` counter; the whole compile wrapped in a span
     with task_id attribute and duration.

3. **System tests** (`tests/system/`, content-named, e.g. `trace-consistency.test.ts`,
   `compiler-agent.test.ts`):
   - First-run eligibility: one successful trace can yield a validated candidate.
   - Exploration separation: different DOM discovery paths for the same work yield a
     reusable plan without replaying the probes; necessary extraction remains.
   - Refusal: incompatible work or unsupported assumptions cannot be validated → a
     descriptive refusal and no active replacement. A raw step-count difference alone
     does not establish incompatibility.
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

---

## Historical implementation, and what replaced it

These notes describe the original S6b implementation. S6d changed eligibility to K=1; S6e
replaced the raw-sequence consistency checker with full-evidence interpretation
(`evidence.ts` + `plan.ts`) and the live dry run with isolated validation (`validate.ts`).

**Deviation: consistency matches on the resolved selector, not "strategy + selector".** Strategy
is not in the trace and never was — `LocatorStrategy` lives on `AnchoredElement` inside the
agent's perception, `summarizePerception` strips it, and `RunSession` is handed an
already-resolved selector string, so `act()` records `{selector}` and nothing about how it was
chosen. Matching on the selector alone is also the right invariant: the compiled script uses
the selector, so the selector is what has to be stable. Threading strategy down would mean
changing S4b's tool surface to carry it into every session call, for information no emitted
script ever reads.

**Two additions the spec did not name, both small:**

- *Failed actions are excluded from the path.* A trace entry with `ok: false` is the agent
  recovering, not the plan; compiling the recovery attempt as if it were the path is how a
  script learns to do the wrong thing reliably.
- *Markdown fences are stripped rather than rejected.* Models wrap code in them however often
  the prompt says not to, and a fence is not a defect in the script.

**Self-repair** is the retry loop the spec asks for, with the gate's own output handed back
verbatim — the same "return the failure unchanged" shape S5e uses for a TeX log. Default budget
is 2 attempts.

Tests: `trace-consistency.test.ts` (accept, order-independence, locator/step-count/emit-type
divergence, originally a two-trace threshold and now K=1, failed-action exclusion) and `compiler-agent.test.ts` (golden
compile against a real browser dry run, fence stripping, self-repair, budget exhaustion,
dry-run throw, consistency-before-model, and the `asset`/`decision` kind filter). Every
rejection case asserts both the descriptive error *and* the absence of a `compiled_scripts`
row — a pipeline that errored but stored anyway would pass the first assertion alone.
