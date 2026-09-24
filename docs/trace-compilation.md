# Post-execution browser trace compilation

> Runtime update: browser execution and compilation now use Python with one Playwright proxy. See [harness-summary.md](harness-summary.md) for the current contract; earlier JavaScript/anchor SDK details below describe the superseded implementation.

Compilation of a trace is a post-execution task. It never runs inline with successful browser
work. A successful browser AI run contributes evidence to a compile job; an LLM separates DOM
exploration from the stable action/extraction/emit sequence and proposes a guarded static script.

The deterministic compiler validates selectors against observed evidence, requires meaningful
guards and dedupe keys, executes the candidate in an isolated validation host, and promotes it
only when the task's content hash still matches. A later guard failure deopts to the browser
agent within the same run. Recovered traces feed a replacement compile; repeated deopts demote
the active script.

Only browser tasks use this path. Decision tasks remain semantic and operate through the store
registry. `stub` is retained only for automated tests and is not an authorable UI mode.

Browser readiness is explicit evidence: AI navigation defaults to the load event with a
60-second budget; load-state, visible/hidden element, and completed-response waits can use
up to 120 seconds within the session budget. Response waits also recognize already completed
requests since navigation, and accept a request-index checkpoint for later interactions.
Network completions retain their URLs, methods, statuses and timings for compilation.

The run inspector displays tool calls, filtering network observations before pagination.
Raw network evidence remains available to the compiler. New browser actions record their CDP
target ID; the inspector also identifies pure AI execution and compiled-to-AI recovery.
A failed page action returns fresh perception, and the agent must explore another target or
extract visible data before concluding that the page is unavailable. Container anchors use
structural locators rather than a snapshot of all their changing text.

The workflow workspace shows the internal task/event graph with packet activity, causation
paths and links to producing/consuming runs. Activity is scoped to the published version;
chat edits update a draft for review and publication. Manual starts operate on the whole
workflow, with no individual-task or arbitrary-event trigger in the control API.

The workflow editor now keeps one conversational assistant visible beside the graph. Its
streamed responses can explain the current workflow, invoke checked graph mutations, and
publish a draft on request. Graph mutations cover steps, event routes, and future packet
contracts; execution packets remain immutable trace history. A failed edit blocks publication
of the preceding draft until repaired. Publication checks the expected version so a chat
cannot silently overwrite a newer publication.

Node and event labels/summaries are presentation metadata in the versioned graph, separate
from operating prompts and packet compiler descriptions. The UI displays these summaries,
with readable routing summaries for older graphs, and does not render internal prompts or
workflow/version database identifiers. Conversation history and unpublished drafts are
retained in this browser; drafts restore only against their original published version.

## Tracked SDK compilation

Current browser agents expose only `browser.code`. Successful invocations record source,
input, used helper revisions and SDK operations with their actual arguments and results.
The compiler first requests an operation-grounded work plan, then a JavaScript module
exporting `default async function(api)`. Exploration can be discarded only with an
explanation. Verification, record disposition, destination readiness, completion and
emissions cannot be dropped. Decision tasks retain their existing tool surface.

Before inserting a candidate, an isolated host replays only the retained operations.
It varies trigger/extracted values and ephemeral observation handles, checks effect order
and emission dedupe keys, removes initial observations, injects guard failures after effects,
and returns uncertain outcomes at write boundaries. Candidates must explicitly deopt
without retrying or continuing effects. This host has no live browser, network or event bus.
These finite trace checks are conservative validation, not a proof for every future page.

Sources use the same SDK operations in AI, compiled and recovery execution. Local JavaScript
loops/functions and pinned helpers are allowed; arbitrary page evaluation, imports and
ambient capabilities remain unavailable. Missing, redacted or oversized evidence refuses
compilation. A trace using different revisions of one helper also requires a new stable run.
A fresh isolate is created each invocation; compiled yields resume only after a checkpoint
changes. Uncertain effects remain journaled and require inspection and exact record
verification before further writes. A deopt continues the same run and browser state.

Artifacts carry runtime/browser compatibility and bundled helper source. Runtime version
`tabductor-sdk-v4` invalidates older artifacts before actions. Existing promotion and
demotion thresholds remain unchanged. Destination harness tasks no longer have a blanket
compilation exclusion: they require complete SDK evidence and runtime verification parity.
The generic browser end-to-end regression is `tests/system/browser-sdk.test.ts`; destination
mapping, record proof and durable helper scope have separate regression coverage.

## Python harness traces

SDK operation schema v2 records Python cells, SDK call nesting, browser results
and workspace file data flow. Compilation supports browser JavaScript and
authenticated browser requests with guarded readback. Static deopts finish in
Python AI mode before recompilation. See [the runtime contract](python-browser-harness.md).
