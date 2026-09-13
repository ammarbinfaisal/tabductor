# S6e — Post-execution trace compilation: the four gaps, closed

**Status:** done. Migration `0020_post_execution_compile_jobs`.

`../trace-compilation.md` is the contract. S6a–S6d built every piece of the machinery and wired
them in a way that did not meet it; this subphase is the correction. Nothing here is a new
capability — it is the same fast path, arriving through the lifecycle the design asked for.

## The four gaps, and what each turned out to be

### 1. Compilation ran inside the execution it was compiling

Both executors awaited `onOutcome` in `finally`, and `createCompileLoop` did the whole compile
there: two model calls' worth of latency and a browser dry run, inside the lifetime and timeout
of a run that had already finished. A slow compiler delayed the run's terminal transition; a
wedged one could eat what was left of the run's clock.

Now the hook does the cheap part only — advance the promotion counter, feed the deopt window,
demote a task that keeps deopting — and writes **one queue row** (`compile_jobs`). A separate
worker (`createCompileWorker`) claims it afterwards, and `claimCompileJob` joins onto `runs`:
**a job whose source run has not settled is not claimable**. The rule lives in the query, so it
holds for every caller rather than for whichever caller remembered to wait. Compilation has its
own outcome (the row), its own timeout (`COMPILE_TIMEOUT_MS`) and its own retry budget
(`attempts`/`max_attempts`), and a refusal is terminal where a transport failure is retried.

A table rather than an in-process queue, for the reason `endpoint_leases` is a table: an engine
that dies mid-compile leaves a `running` row whose heartbeat goes stale, and the next worker
reclaims it instead of losing the eligibility a real run paid for.

### 2. The model never saw the run

`consistency.ts` filtered the trace to a fixed allowlist of "structural" actions, dropped every
failed action and every `perceive`, and then required the remainder to match across runs. The
contract asks the compiler to *separate exploration from work* — and a filter that has already
discarded the exploration has also discarded the evidence that an inspection supplied data the
work depends on. Worse, it rejected honest runs: two agents that found the same page by
different routes "diverged".

That module is gone. In its place:

- **`evidence.ts`** — the whole execution, in order, nothing dropped: every action successful
  and failed, every navigation, extraction row counts, emitted types with whether a dedupe key
  rode along, model turns, policy denials. Page *content* is still absent, because the trace
  never had it (§14), which is what makes "do not hard-code the posts you saw" structural
  rather than an instruction.
- **`plan.ts`** — the model answers with a `WorkPlan`: guards, ordered steps, the events to
  emit with their dedupe field, and a required `discarded` list saying what it threw away and
  why. Then deterministic grounding: every URL, every event type and every selector the script
  *acts on* must appear in the evidence, and every event type any trace published must appear
  in the plan. Exploration may be discarded; work may not.
- **`compile.ts`** — two turns. Distil, gate the plan, then write the script from the approved
  plan. The second turn is a transcription job, which is why handing it a gate's own words
  verbatim is enough to get a corrected attempt.

Cross-trace comparison is now of the distilled work: a supporting run that published an event
type the plan omits is a divergence and refuses; a supporting run that clicked through three
extra menus is not.

**Deviation, recorded: read selectors may generalise, under a guard.** An agent addresses a list
one anchor at a time — `:nth-match(a:text-is("permalink"), 2)` — so a literal grounding rule for
*every* selector would force the script to re-address those exact anchors, which is precisely
the over-fitted replay the contract forbids. `click`/`type` stay strict (they change the page).
`extract`/`waitFor` may name a selector no trace named **only if a `guard.exists` asserts it**,
so a wrong generalisation deopts to the agent instead of silently emitting nothing.

### 3. Validation drove the live site

The dry run borrowed the workflow's own endpoint and ran the candidate against the real page,
with only the event bus suppressed. For a scraping task that is merely wasteful; for a task
whose work is to *post*, *submit* or *send*, suppressing emissions does nothing at all — the
side effect is not an emission.

`validate.ts` builds the page out of the evidence instead: a `RunSession` whose every method
answers from what the run recorded, and which has no way to reach the network. Three passes,
each a precondition for the next meaning anything:

1. **The work**, on the evidence's own shape — must complete, must publish every event type the
   run published, must publish one per extracted row (a script that emits once for a ten-row
   page has collapsed the work).
2. **Idempotency** — the same script again, same state: must publish nothing new. A script that
   forgot `dedupeKey` cannot pass.
3. **The page moved** — the guard's own selector removed: must `deopt`, not throw, and must not
   publish anything on the way out.

This is not a claim that the script works live. Nothing short of running it there is, and
running it there is the thing we may not do. `compile-validation-isolation.test.ts` is the
statement of what it *is*: a candidate that clicks FakeGram's submit button compiles, and
FakeGram — running, reachable, counting — records no submission.

### 4. Artifacts outlived the task content they implemented

Three separate bugs under one heading:

- `contentHashOf` hashed the **compiled prompt**, which folds in every neighbour's prose. Editing
  an unrelated node's wording changed this task's hash, dropped its script and sent a working
  fast path back through an AI run it had already paid for. The hash is now over this task's own
  content: kind, its own prompt, and the schemas of the events crossing it.
- A carried script arrived on a fresh row with `clean_ai_runs = 0` and an empty deopt window, so
  every publish handed a quietly-failing script ten more runs before demotion could notice.
  `carryHistory` carries the record with the script.
- `updateTask` edited a prompt in place and left the old compiled prompt *and* the active script
  valid. A prompt edit now clears both hashes and the compiled prompt, invalidates the active
  script and drops a promoted task back to `ai` — the next publish recompiles. A limits-only
  edit touches none of it.

And the guard on the other side: a job records the `content_hash` it was queued against, and
`promoteTask` re-reads the task before activating. A compile that started before an edit cannot
overwrite the definition that replaced it.

## Also fixed here (found while wiring the executor's emit)

`compiled-executor.ts` cast the agent's `EmitFn` to `ctx`'s. They are not structurally
identical — the agent's third argument is the dedupe key, `ctx`'s is an options object — so
every `emitIfNew` in a compiled run claimed the key `emit:<type>:[object Object]`. The first
event published; every later one, in that run and every run after, was silently deduped away.
It is an adapter now, translating the outcome back as well. `compile-loop.test.ts` asserts the
property that was broken: three tweets, three events, whichever mode published them.

## Where a compile's own diagnostics live

On the job row, and in metrics — never in the source run's trace. `compile_jobs` carries the
stage and reason of a refusal, the attempt count and the script it produced;
`compile_runs_total{outcome}` and `compile_duration_seconds` carry the shape of the whole
population, and the compiler's model calls are metered under `llm_cost_usd_total{mode="compile"}`.
The contract's rule is that compiler turns must not appear as actions performed by the completed
run, and the simplest way to honour it was to give the compile worker's `Llm` no trace recorder
at all: there is no run for it to write to.

## What this subphase did not do

The UI shows nothing about compile jobs. A refusal now has a durable reason (`compile_jobs.error`)
and a durable history, which is exactly what a node panel should show next to "fast path
active"; wiring that is a UI slice, not this one.

## Tests

`compiler-agent.test.ts` (the pipeline, twelve cases: distillation, exploration separation,
ungrounded plan, dropped event, both validation refusals, self-repair, budget, missing evidence,
kind filter), `compile-jobs.test.ts` (claim timing, one open job per task, single-claim, refusal
vs failure, stale reclaim), `compile-loop.test.ts` (the e2e: settle, then compile, then a
compiled run with zero model calls — with the CDP endpoint deleted during the compile, to prove
it needs no browser), `compile-validation-isolation.test.ts` (no live side effects),
`publish-modes.test.ts` (neighbour edits keep the script and the history; a prompt edit retires
both), `compiled-executor.test.ts` (eligibility and promotion as two steps, content-hash guard).
