# S6d — The modes model: what an author picks, what the engine decides

**Status:** done. Migration `0019_modes_model`. The compile *wiring* described below was
superseded by [S6e](S6e-post-execution-compilation.md), which moved compilation off the
executor's `finally` and onto a queue; see [trace-compilation.md](../trace-compilation.md).

## The fault

U3a shipped a per-kind Mode selector offering `stub | ai | compiled` for browser nodes and
`stub | ai | python` for asset nodes, and a Python editor behind `python`. Both extra options
were wrong, for different reasons:

- `compiled` is not something an author can *mean*. No script comes with a document, so a
  task published that way failed every run with "no active compiled script". Worse, the real
  path — S6c's promotion flipping `tasks.mode` — was never wired into the engine (`recordAiRun`
  had no production caller), and every publish minted fresh task rows, so a task that *had*
  been promoted lost its script on the next save.
- `python` made compute a separate authored program on a separate node, when the product's
  premise is that the asset node is an agent that produces deliverables with tools. A
  spreadsheet is a tool call, not a mode.

## The model now

| | editor-authored | engine-assigned |
|---|---|---|
| browser | `ai` | `compiled` (after post-execution compilation validates a candidate; K=1 eligibility; back to `ai` after 3 deopts in 10) |
| asset | `ai` | — (`python.run` is always on the `ai` registry) |
| decision | `ai` | — |

The editor has no mode selector. `stub` remains available through the backend for automated
tests, but is not a product authoring option. Existing stub nodes are converted to `ai` in
the editor's draft on load or reload; the draft is marked unpublished and requires a publish
before manual triggering. Loading a workflow does not change its live tasks or schedules.

`checkGraph` rejects `compiled` and `python` in a document with a message that says why;
`updateTask` refuses the same. `readGraph` maps a promoted row's `compiled` back to `ai` so the
editor round trip never trips that gate. `mode` stays an open string (test-only `scripted`
still publishes); the DB check keeps only the asset/compiled exclusion.

## What publish compiles

Beside the packet schemas (EC1), `publishVersion` now compiles, per node:

1. **`tasks.compiled_prompt`** — the detailed internal prompt the executors actually run
   under (`packages/engine/src/prompt-compiler.ts`). A deterministic *brief* built from the
   whole graph — the author's sentence, the consumed and emitted events with their compiled
   schemas and their emitters/consumers, every other node, the kind's tool surface, the
   workflow store's tables — with an optional model layer on top that turns the intent into
   ordered operating instructions (gated: non-empty, bounded, names every emitted event; one
   repair turn; falls back to the brief alone and the report says `brief`). Carried forward by
   `compiled_prompt_hash`. The author sees and edits only `prompt`.
2. **`tasks.content_hash`** (graph-compilation-llm §6.3): kind + compiled prompt + the exact
   schemas crossing the task. A browser task published as `ai` whose previous row was
   `compiled` with an active script *and* the same hash stays `compiled`, and the script is
   re-shelved under the new row. Any change to what the script was compiled against sends it
   back to `ai`. `PublishedVersion.taskModes` and `report.tasks[].mode` say what happened.
3. **The workflow store** — given a pool, publish provisions `wfdata_<id>` and its role pair
   (idempotent) so `store.*` has somewhere to go from the first run, and the published tables
   go into every node's brief. The store *schema* (DDL) is still its own publish call; S8's
   graph compiler is where one pass produces both.

## Trace compilation: contract and current wiring

The first successful browser execution makes its completed trace eligible (**K=1**) for
a separate LLM task. Execution must settle, flush its trace and release its session first.
The compiler separates DOM exploration from actual work, preserves required actions and
data flow, validates a reusable script in isolation, then promotes the matching task.
Recovered deopts follow the same post-execution path. Compile failure must not alter the
completed run. The complete contract is in `../trace-compilation.md`.

S6d's wiring did not meet that lifecycle — `createCompileLoop` was awaited by both executors'
`onOutcome` hooks before run settlement, its checker compared reduced raw action sequences
before the LLM, and validation borrowed the live endpoint. S6e closed all three: the hooks now
queue a `compile_jobs` row and nothing more, and a separate worker compiles. `compile.promoted`
is published by the worker on promotion; `compile.invalidated` still rides the hook, because
demotion costs one insert and is the one thing here a user has to be told about promptly.

`compileTask` no longer borrows a host at all: S6e's validation builds the page out of the
trace, which is what actually isolates live side effects. The lease leak it used to guard
against cannot recur, because there is no lease.

## `python.run`

`packages/agent/src/python-tool.ts`. Always on the `(asset, ai)` registry; fails closed with a
tool error without `PYRUNNER_URL` (the `assets.render` precedent). Inputs are asset paths the
host resolves; outputs under `out/files/` become assets, grant-checked, two-pass; stdout/stderr
and any `out/emits.jsonl` come back to the model as untrusted text — the model emits, the
program does not. `engine_status.capabilities` tells the editor whether the tool is live. The
`(asset, python)` executor, `python-tools.ts` and the `code`/`runtime` columns are gone.

## UI

Every new node uses `ai`; a read-only line explains execution for its kind; a
promoted row shows as "fast path active"; the compiled internal prompt is a collapsed read-only
section on the card; `/status` lists `tool python.run` beside the executors.

## Tests

`publish-modes.test.ts` (brief contents, hash carry-forward, gated model layer, brief fallback,
compiled carry-forward and reset, `readGraph` normalisation, store provisioning),
`compile-loop.test.ts` (the flagship: one replayed `ai` run → promoted with a script compiled
from exactly that run → second run `compiled` with zero `llm` rows; a failed run compiles
nothing), `python-tool.test.ts` (host boundary with a fake runner, real-runner round trip,
loop-level call via replay), plus the updated `kind-constraints`, `compiled-executor`,
`deopt-loop`, `trace-consistency` and registry-isolation suites. Asset replay fixtures gained
`python.run` in their recorded tool sets, which is the replay adapter's own drift check
doing its job.
