# S6c — CompiledExecutor + deopt handoff + promotion/demotion (flagship e2e)

You are implementing subphase S6c. Read, in order:
1. This file (authoritative).
2. `docs/techical_plan.md` — §11 (deopt semantics, promotion rule, deopt budget — the
   numbers there are binding: K=2 promotion, 3-in-10 demotion), §12 (ctx crossing into the
   host), §17.2 (metric names), §18 decisions 5 (automatic recompilation) and 6.
3. `docs/impl-phases.md` — Phase 6 build steps 5–6 and the flagship test description
   (your e2e must match it step for step); §0.5.
4. `docs/subphases/ROADMAP.md`.

## Scope

Existing code to reuse (read first): `packages/static-rt` (S6a sandbox host + `ctx`),
`packages/compiler` (S6b `compileTask`, consistency checker, script registry),
`packages/agent` (S4b `AgentExecutor` — the deopt handoff target), `packages/engine`
(executor registry keyed on `(kind, mode)`; run state machine), `packages/browser`
(run session the ctx drives).

NOT yours: any change to the compiler agent's prompt or the lint gate (S6b/S6a); policy
(AllowAllGate stays until S7). You wire existing pieces into the engine and close the loop.

## Deliverables

1. **`CompiledExecutor`** (`packages/engine` or `packages/compiler` — put the executor next
   to the registry it reads, wire it in the engine's registry for `(browser, compiled)`):
   - Loads the task's `status='active'` script; executes it in the S6a sandbox with `ctx`
     bound to a real run session (driver page, trace recorder, emit, `ctx.state` backed by
     `task_state`). Every `ctx` call crosses to the host and through `PolicyGate` (§12) —
     this already exists in S6a; do not duplicate checks.
   - A compiled run that completes without LLM involvement must produce a trace with
     **zero LLM-call entries** — that absence is asserted in the flagship test.
   - **Activation:** a `candidate` script becomes `active` when its task is promoted (below)
     or, for a recompile of an already-compiled task, immediately on passing S6b's pipeline
     (§18.5 — recompilation is automatic). Activating v(n+1) sets v(n) to `invalidated`.

2. **Deopt handoff** — `ctx.deopt(recoveryPrompt, evidence)` does NOT fail the run:
   - The executor catches the deopt signal and continues the **same run row** under
     `AgentExecutor`, mid-run: agent context = compiler-authored recovery prompt + the
     original task prompt + guard failures/evidence + the current page (same session, page
     left untouched). `runs.mode_used` stays `compiled`; the trace records a `deopt` entry
     with the trigger class, then the agent's entries follow.
   - A deopted run that **succeeds** flags its trace `deopt_recovery` and enqueues
     recompilation (call S6b's `compileTask` with the fresh trace; automatic, §18.5).
   - Deopt triggers the executor itself must detect (beyond in-script guards): missing
     element at action time, unexpected dialog, navigation to an unexpected URL, zero
     extraction where guards passed, step timeout (§11 list).

3. **Promotion/demotion** (counters on `tasks`, engine-side):
   - **Promote:** after K=2 clean consistent `ai` runs (S6b consistency checker decides
     consistency), compile; if a candidate passes the pipeline → flip task `mode` to
     `compiled`, activate the script. Asset and decision tasks are exempt (S6b's selector
     already filters; the counters must simply never advance for them).
   - **Demote:** 3 deopts within the last 10 runs → task `mode` flips to `ai`, active
     script → `invalidated`, emit `compile.invalidated` (system event, §6) so the user
     notices instead of silently paying for AI every run.
   - Telemetry (§0.5, binding names): `deopts_total{trigger}`, `promotions_total`,
     `demotions_total`; LLM cost keeps flowing to `llm_cost_usd_total{model,kind,mode}` —
     with `mode` now meaningfully splitting ai vs compiled.

4. **System tests** (`tests/system/`, content-named, e.g. `compiled-executor.test.ts`,
   `deopt-loop.test.ts`):
   - **Flagship deopt-loop e2e — exactly as impl-phases Phase 6 states it:** run the
     canonical fake-tweets task twice in AI mode (replay) → auto-promotion compiles and
     activates → compiled run succeeds with **zero LLM calls** (assert no LLM trace
     entries) → flip fixture to `mutator?layout=v2` → guards fail → deopt → agent (replay
     recovery transcript) finishes the run → recompile produces v2 (v1 `invalidated`) →
     next run: compiled v2, zero LLM calls, on the new layout.
   - Demotion: force 3 deopts in 10 runs via mutator toggling → mode flips to `ai`,
     `compile.invalidated` observed on the bus, active script invalidated.
   - Idempotent polling: compiled run twice against an unchanged fixture — second run emits
     nothing (`emitIfNew` + `ctx.state` cursor).
   - Cost accounting: after the flagship test, the run records show LLM cost on the ai runs
     and the deopt recovery, and zero on clean compiled runs — the ai-vs-compiled
     cost-per-run comparison must be computable from stored data (this is the product's
     core claim; §17.1/§17.2).
   - Mid-handoff crash: kill the engine between deopt and agent completion → watchdog
     fails the run per S2b semantics, retry policy applies, no orphaned page.

## Style constraints (binding)
- The handoff passes data (prompt, evidence, page handle) — do not invent a
  "DeoptCoordinator"; it is a code path inside the executor.
- Counters are columns on `tasks` (one additive migration), not a new table.
- New deps: none.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests stay green; run the flagship test twice — replay determinism is the point.

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Do NOT git commit.
