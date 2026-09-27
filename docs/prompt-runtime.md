# Prompt workflows and session replay

A workflow version contains the original user prompt, optional JSON result schema,
runtime limits, and schedule. Saving does not call an authoring model. An unchanged
prompt preserves its compiled runtime; editing its prompt, schema, or limits creates
a new runtime version. Schedule-only edits preserve compilation.

Each execution admits one browser runtime. Emitted events are durable evidence;
they never dispatch downstream tasks. Production entrypoints no longer expose graph
authoring, decision executors, or result nodes. The historical graph builders live
under explicit `testing` package exports for migration/compiler regression fixtures.
The database's internal `tasks` table holds the single runtime for each version.

The runtime retains browser Python, model calls, secrets, record accounting, and
guarded compilation. Learned Python is replay-validated before promotion. A failed
guard deoptimizes into AI recovery using the existing progress and operation archive.
The result of either execution mode is persisted for an independent, durable finalizer.
The finalizer has no browser tools, validates the optional result schema, and retries
up to three times without repeating the browser work.

`browser.store.define_table`, `query`, `insert`, and `upsert` are available from
Python. Tables can gain nullable columns; existing column types and primary keys
cannot change. Writes commit before acknowledgment and carry an execution-scoped
idempotency key. Reusing a key with changed input fails. Compiled queries observe
fresh rows and must guard their identities, shape, and truncation before effects.

Every Watch live link points to `/sessions/{sessionId}`. That URL shows live browser
control while active and recording playback afterward. A replacement-session selector
keeps related sessions accessible. Event rows show safe summaries with fixed color
labels; screenshot/navigation titles are deterministic. Other Python calls use
`gpt-6-luna` (override with `ACTION_SUMMARY_MODEL`) and strict `{label, description}`
output, capped at 180 characters. Text beside each call explains the code's concrete
operations and sequence; execution status remains separate. Missing credentials or failed summaries fall back
to generic tool descriptions. Model requests show token counts, never reasoning.

Worker command timestamps use the recorder clock and correlate to root tool-call
IDs. Playback converts recording offsets into concatenated HLS time, accounting for
startup gaps and omitted private intervals. Events without authoritative timing
remain visible without inventing a seek position. Human takeover makes the remaining
recording private, preserving the existing browser-control behavior.

Deployment includes migrations 0059–0061. Before migrating an existing graph-based
installation, run `scripts/reset-workflows.mjs` inside its old engine environment and
wait for the ordinary deletion queue to finish. This reset deletes workflows and
their operational data while preserving accounts, credentials, model settings,
profiles, and financial history. Do not run the old application after migration
0061 renames `graph_json` to `definition_json`.
