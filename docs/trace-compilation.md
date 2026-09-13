# Trace compilation

**Status:** Current design contract, clarified 2026-09-11 and **implemented by S6e**
(`subphases/S6e-post-execution-compilation.md`, migration `0020`). This is the source of
truth for trace compilation timing, trace interpretation, validation and promotion.

## Two different compilation tasks

Publishing compiles event schemas and detailed internal node prompts from the authored
graph, and provisions the workflow store. It does not have a browser execution trace yet.
Generating the store's table schema from prose remains part of the planned S8 graph compiler.

Trace compilation happens **after browser execution has finished**. A separate LLM task
reads the completed execution's evidence, separates DOM exploration from the actual work,
and produces a reusable browser script. It is not a recording played back verbatim.

The editor authors every node as `ai`; there is no mode selector. The engine alone assigns
`compiled` to browser nodes with an activated script. Asset and decision nodes remain agents;
asset agents use `python.run` as a tool. `stub` is retained for automated tests, not UI authoring.

## Lifecycle

1. The browser agent performs the task, including whatever DOM exploration it needs.
2. Finish the execution: persist its terminal outcome, flush its trace and release its
   browser session and endpoint lease before starting compilation.
3. A successful initial AI execution, or a successful deopt recovery, makes its completed
   trace eligible for a separate compilation job. **K=1**: a second successful execution is
   not a prerequisite. Available additional traces provide supporting evidence.
4. The compiler LLM distills the trace into the work the script must reproduce. Deterministic
   checks validate the resulting plan and script against the task contract and evidence.
5. Validate a candidate in the static sandbox with fixture/replay or otherwise isolated
   validation inputs. Activate it only if it passes and still matches the task definition.
6. Subsequent runs use the active script. While compilation is pending, an unpromoted task
   continues in `ai`; a task with a valid active script can continue using that script.

Compilation has its own outcome, timeout and retry budget. Its latency, refusal or failure
cannot change the completed run's outcome or trigger a retry of work that already succeeded.
Compiler LLM calls and validation actions belong to compilation diagnostics linked to the
source runs; they must not appear as actions performed by those completed runs.

## What the compiler LLM does

The input is the task's detailed internal prompt, event contracts, trigger context and the
available full trace evidence: observations, DOM inspection, attempted and completed actions,
network reads, extractions, emitted packets and recovery steps. Missing evidence due to storage
settings can prevent compilation; the compiler must not invent the missing work.

The LLM identifies which observations helped the agent discover the page and which actions
were necessary to fulfill the task. Repeated DOM inspections, selector searches, exploratory
clicks and abandoned attempts are evidence for reasoning, not automatically script steps.
Necessary navigation, waits, data extraction, input values, business actions, event emissions
and cursor/deduplication behavior must survive. An inspection that supplies required data
becomes a deliberate extraction; it is not discarded merely because it reads the DOM.

For example, an agent might inspect a timeline repeatedly, try an irrelevant menu, discover
the post selector and then extract new posts. The script should navigate, verify the page,
extract current posts and emit new records. It should not repeat the menu exploration or
hard-code the example posts observed during compilation.

With several traces, compare the **distilled work and its assumptions**, not equality of every
exploratory step. Different discovery paths can implement the same task. The LLM proposes
the interpretation; deterministic validation remains the gatekeeper.

## Validation, promotion and recovery

- Generated code uses only the supported static runtime interface and passes its lint and
  sandbox gates. Guards verify assumptions; failed assumptions hand control to the agent.
- Validation must not repeat live external side effects such as posting, submitting a form
  or sending a message. Suppressing event-bus emissions alone does not make a live browser
  replay safe. If isolated validation cannot establish correctness, retain the current mode.
- A clean first run is eligibility to compile, not a promise that a usable script exists.
  Compilation refusal leaves the task in `ai`; a failed replacement preserves a valid prior
  script. Promotion is engine-assigned only after validation.
- Deopt recovery continues the same execution under the agent. After that execution settles,
  its recovery trace enters the same post-execution compilation process.
- Three deopts in the last ten compiled runs demote the task to `ai` and emit
  `compile.invalidated`. Promotion emits `compile.promoted`.
- Artifacts must match the task content they implement. Unchanged tasks should retain their
  scripts and promotion/deopt history across publish; obsolete compilation results must not
  overwrite a newer task definition. See [graph versioning](graph-compilation-llm.md#63-graph-versions--compiled-scripts).

## How it is implemented

`compile_jobs` is the separation. The executors' `onOutcome` hooks do only what belongs to the
run that just finished — advance the promotion counter, feed the deopt window, demote — and
write one queue row. `claimCompileJob` joins onto `runs` and will not hand out a job whose
source run is still in flight, so a compile begins only after the run is terminal, its trace is
flushed and its endpoint lease is released. The job row carries compilation's own outcome,
timeout and retry budget; a refusal is terminal, a transport failure is retried, and a claim
whose worker died is reclaimed once its heartbeat goes stale.

The compiler reads the whole trace (`evidence.ts`) — failed actions, observations and all —
together with the task's detailed internal prompt and its declared event contracts, and answers
with a `WorkPlan` (`plan.ts`): guards, ordered steps, the events to emit with their dedupe
field, and an explicit list of what it discarded and why. Deterministic grounding gates that
plan before any code exists. Selectors the script *acts on* must appear in the evidence;
selectors it only *reads* may generalise from the anchors an agent walked to the collection they
came from, but only under a `guard.exists` that turns a wrong generalisation into a deopt. Every
event type any trace published must appear in the plan. Then a second turn writes the script
from the approved plan, through the lint gate.

Validation (`validate.ts`) never touches a live page: the candidate runs three times against a
`RunSession` built out of the evidence — the work, the same work again for idempotency, and the
page changed for the deopt door. A script that emits without a dedupe key, collapses a multi-row
page into one event, or cannot deopt when its assumptions fail, is refused and nothing is stored.

Promotion re-reads the task and refuses when its `content_hash` no longer matches the job's. The
hash covers this task's own content — its kind, its own prompt, and the schemas of the events
crossing it — so a neighbour's edit no longer discards a working script, and a carried script
carries its promotion/deopt history with it. An in-place prompt edit retires the compiled prompt
and the active script rather than leaving both valid.

Not covered by this document, and still open: the UI shows nothing about compile jobs, though
`compile_jobs.error` now holds a durable refusal reason per task.
