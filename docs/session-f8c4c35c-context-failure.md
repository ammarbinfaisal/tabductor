# Context compaction failure, 2026-09-27

Investigated local PostgreSQL (`tabductor-postgres-1`) and engine container logs.
All times below are UTC.

- Session: `session_f8c4c35c-57ec-478c-a6df-9aaf6fff2fb3`
- Execution: `exec_e70fa2c5-1a56-4bc7-9665-b3ca82db5529`
- Run: `run_0aca2868-68d4-43c1-b006-bfb1012064e7`
- Model recorded on the execution: `gpt-5.6-terra`
- Run started at 11:13:49 and failed at 12:03:38.652 with
  `Context summary exceeded 8000 characters; original history is retained`.
- The browser session ended at 12:06:49 with `browser_outcome_uncertain`.

## Cause and evidence

`runAgentLoop` calls `compactHistory` when conversation history or the model input
exceeds its budget. Compaction summarizes older turns in successive chunks and
merges each chunk into a rolling summary. Its prompt requested at most 6,000
characters, but the code immediately threw if a response exceeded 8,000. There
was no repair attempt for that chunk. A presentation failure consequently became
a failed workflow after browser side effects had already occurred.

The durable trace ends with a successful `browser.python` inspection and screenshot
at sequence 9478 (12:02:27.406), followed by five model responses without tool calls
at sequences 9479–9483. The last response is timestamped 12:03:38.621, immediately
before the run error. This is consistent with successive summary chunks ending in
an oversized response. They are not five retries of the invalid summary: the
implementation had no such retry loop. No completed `context.compacted` event was
recorded for this run.

The LLM traces contain token usage and tool names, not summary text or character
counts. The exact oversized length cannot be recovered from those traces. Engine
stdout does not contain this run's exception; `runs.error` and `trace_entries`
provide the durable failure evidence.

## Why the result says 107 records and 100 failures

| Collection | Ledger entries | Final status | Structured verification |
| --- | ---: | --- | --- |
| `x_tweets` | 100 | failed | none |
| `notion_rows` | 2 | saved | none |
| `tweet_extracts` | 5 | saved | none |

There are only **100 distinct record keys (source URLs)** across these 107 entries.
The two `notion_rows` keys also occur among the five `tweet_extracts` keys. All five
occur in `x_tweets`. Thus seven save reports describe five distinct source URLs,
not seven independently verified destination rows.

The run's explicit outcomes still show 100 `x_tweets` entries as `extracted`.
`recordFailedRun` changed their workflow ledger status to `failed` at 12:03:38.653
because they remained unresolved when the run failed. These are not 100 observed
destination write failures. Changing collection names when reporting saves created
new identities rather than updating the extracted identities.

The saved reasons claim visible matching rows, but every `verification_json` is
null. They remain reported saves; this investigation does not establish the actual
destination contents.

## Fix

Both compaction paths now use a shared validator with at most three attempts per
chunk. Invalid responses are regenerated from the original evidence with targets
of 6,000, 3,000, and 1,500 characters; the acceptance limit remains 8,000. Retry
feedback is budgeted, requests are checked against the model input budget, and
cancellation stops retries. No browser operations are replayed by the retry.

History is committed only after a valid summary. Exhausting retries retains the
original history and returns an error with attempt and character counts. Rejected
responses also produce `context.summary_rejected` trace events without recording
summary contents.

Record guidance now explicitly requires the original collection and record key
throughout status updates, and summaries are instructed to preserve those pairs.
Collections remain separate identities; unrelated collections are not automatically
merged by matching keys. Historical records and destination rows were not modified.

Regression coverage exercises oversized and unusable responses, successful retries,
retry exhaustion after earlier chunks, exact character boundaries, input limits,
cancellation, durable archive preservation, and continued agent execution without
repeating tools.
