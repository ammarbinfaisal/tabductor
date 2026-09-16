# Post-execution browser trace compilation

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
