The X → Notion reference demonstrates successful recovery, not error-free UI automation.
`data/x-notion-browser-calls.jsonl` contains 48 cells over about 40 minutes. The run
collected 100 records into `data/x-for-you-100.json`, discovered the database UI,
used bulk entry, inspected focus and individual cells, and reconciled the result
using browser-authenticated database reads. Cell 46 found 13 text mismatches despite
100 unique URLs. Cell 47 corrected one through the UI and observed the application's
write request; cell 48 repaired the remaining 12 and read back zero mismatches
against the source after the reference script's whitespace normalization.

The failed workflow's first writer, `run_0776868a-2eeb-44dc-9769-f0bb07568307`,
had a much shorter opportunity: 01:05:25–01:08:14 UTC. Its first model request used
16,009 input tokens. It attempted an unsupported `destination_contract_id` argument,
recovered, created a blank row, then looked for HTML `table`/`button` elements where
the accessibility tree described roles. Broad subsequent DOM reads included large
amounts of sidebar text. The run made six context-summary calls. A collector-side
`browser.disconnected` error stopped the shared session before any record was saved.
The selected workflow model was `gpt-5.6-luna`; the supplied reference does not record
the Codex model/settings. This is not a controlled model or time-budget comparison.

The local improvements address information delivery and recovery:

| Area | Change |
| --- | --- |
| Tool discovery | Compact gateway signatures plus `api.tools.describe(name=...)` for exact schemas and instructions. Core helpers document Python return shapes. |
| Working strategy | Focused observe/act/check cells, actual DOM/role inspection, focus checks when ambiguous, reusable functions once a sequence works, and destination identity/field comparisons. These are guidance, not new execution gates. |
| Large output | Explicit head/tail preview and omitted offsets, with complete output retrievable through `output.read`, including after exceptions. |
| History | Search by method, cell, text or failure; retain full archived evidence after compaction. Collapse only identical successful wrapper/gateway results in working context. |
| Memory | Preserve assistant prose accompanying tool calls. Compaction explicitly retains created row IDs, field mappings, pending fields, workspace files and failed approaches alongside existing checkpoints and exploration memory. |
| Compaction | Batch older complete turns, count native model messages, aim for 20% token headroom, and retain the latest complete turn. Emit `context.prepared` budget metrics. |
| Writer continuity | Retain conversation, archive, summary, memory and workspace across records in one execution/task/destination revision/language. Serialize ownership; pass current input and an explicit handoff; keep each record's checkpoints and verification separate. Works in AI and compiled fallback. |

No Notion-specific IDs, endpoints or selectors from the reference are embedded in
the runtime. Existing arbitrary browser JS, screenshots, file-backed Python,
authenticated same-origin requests and verification primitives already provide
the main mechanisms used by the reference.

The next acceptance run should use a disposable destination with the same model,
settings and adequate deadline across both harnesses. Start with one record and
an editor implemented using custom roles; then exercise 100 records containing
quotes, Unicode and multiline text. Compare exact fields, missing/duplicate IDs,
blank rows, recovery after a failed selector, model/tool calls, summary calls and
elapsed time. Repeat across layouts and runs; a deterministic tool test does not
measure the model's ability to discover a workflow.

Writer continuity is now implemented locally; see `python-browser-harness.md` for
its ownership, recovery and scope boundaries. Recovering from an isolated page
closure without stopping unrelated tasks remains separate.
The observed disconnect still needs its own reproduction; these context
changes do not claim to fix it. The changes have not been deployed or validated
against the user's live Notion database.
