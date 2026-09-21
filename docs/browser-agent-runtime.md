# Browser agent runtime

Browser tasks retain the same session, policy checks, event schemas and run lease whether
the model calls a tool directly or invokes it from JavaScript. These are browser-task tools,
not a new task kind or a general-purpose server runtime.

## Control and context

Browser results preserve `{ok,value,error}` and add `action`, `observation`, and `recovery`
metadata. An action summary reports its semantic target, dispatch status (`executed`,
`rejected`, `failed`, or `uncertain`), observed UI changes, and explicit verification status.
A successful click proves dispatch, not completion. If its readback fails, the action
remains executed and the observation becomes unavailable; observe again rather than
replaying the effect. Cancellation, control changes, lease loss and terminal limits still
interrupt execution.

After UI-changing actions, the harness samples every 150 ms for 300 ms of stable relevant
UI, with a 1.5-second sampling budget bounded by the remaining session allowance. An
in-flight browser read must finish before another can start. The observation reports
`settled`, `unsettled`, or `unavailable`; settling does not establish task completion.
Active dialogs and editors take priority over background controls. Scoped inspection
returns meaningful controls and text first; `structuralDetail:true` includes wrappers in
document order for extraction and hierarchy work. Preserve this option when paging.

The last 20 action summaries (at most 12,000 serialized characters) live in a separate,
lease-fenced `agent-actions:<trigger-or-run>` task-state entry. This history survives
snapshot pruning, context compaction and retries, including actions inside `browser.code`.
Summaries already present in tool results are not duplicated in kickoff context. `memory.get`
exposes this history; `memory.set` cannot replace it. Labels remain untrusted historical
data, not current anchors or an exactly-once journal. Typed values, passwords, full page
text and URL queries are not copied into summaries. Default traces contain only summary
IDs, structural outcome classifications, settling durations and cycle rejection counts.

Cycle rejections include a structured semantic action sequence and suggested inspection
tools. Reads do not reset a detected mutation cycle. The existing third-rejection limit
still terminates the run; nested browser scripts preserve that terminal outcome.

Each workflow execution uses one hosted browser with reusable tabs. By default, all packet
runs of a browser task share its tab. Set `limits.browser.tab_key` to a shared name when
different task nodes should use the same tab. For X → Notion, the extractor uses its X tab
while every write packet takes a turn on the Notion tab: M tabs serve N task runs.

A database lease gives one run exclusive use of a tab for its whole invocation. Different
tabs execute concurrently. Waiting for a busy tab consumes no model calls and is governed
by the run's deadline. Releasing a run retains the tab's URL and page state; its next user
receives fresh anchors, tracing and network hooks. Cancelled or expired run owners cannot
issue commands or release a replacement owner's lease. Profile setup and other executions
still respect the profile lease; tabs share authentication inside one browser process.

The session inspector lists open tabs with title, URL, task and working/available status.
Selecting a tab brings it into the live view. Human takeover pauses the entire browser
and waits for commands on every tab to finish. Once the execution settles, the fleet stops
the browser and saves its profile. Browser duration, command and 16-tab limits still apply.
Deploy migrations through `0044_broad_skaar` with the engine, fleet, worker and web changes.

The hosted connection waits for the worker to acknowledge the resumed input generation
before initialization, the next model call, or any pending tool. Resume requests and actual
acknowledgements are separate activity events; the inspector shows “Resuming…” until the
acknowledgement arrives. Reading the worker version cannot bypass fresh-perception fencing.
Ownership rejections remain recoverable control pauses. A changed input generation causes fresh perception and discards
remaining actions from the old model response. The command fence still checks ownership
at dispatch, covering takeover races after the loop checks. Code also discards subsequent
actions after takeover; trusted control waits suspend its host wall timer, not its CPU cap.

Page recovery permits failure after two further page attempts. Missing locators and invalid
selectors remain recoverable; lost leases, cancellation, and resource limits remain runtime
errors. A terminal tool stops the current tool list immediately.

History is compacted when it exceeds 60,000 characters. Recent turns and the durable
checkpoint survive; oversized individual results become explicitly labelled previews.
Use checkpoints and batch handles for working data, not prior model messages. Model
admission tokenizes the serialized text and JSON tool schemas with o200k_base and a 25%
plus 1,024-token allowance. This is an estimate, especially for other providers, not billing
usage or an exact provider context count. A separate 4 MB request-size ceiling applies.
Provider-reported usage remains authoritative for accounting.
Perception returns up to 100 anchors within its serialized observation budget; `page.perceive` accepts `elementOffset`
and `elementLimit` to follow `nextElementOffset` without hiding later controls from the agent.

## Collection tools

- `page.extract` resolves one anchor; ambiguous roots fail rather than silently returning
  several records. Action anchors identify observed DOM nodes; semantic selectors are
  retained separately for compilation.
- `page.extractBatch` takes an item `selector`, optional container `anchor`, relative
  `fields`, `offset`, and `limit` (1–100; default 25). It returns a `batchId`, row count,
  next DOM offset, and a two-record preview. A full page does not establish that more data
  exists; scroll and observe the application's actual stopping condition.
- Both drivers use Playwright field selectors and first-match/null semantics. Extraction
  is limited to 100 rows and 16,000 characters per field. The batch default is 4,000 field
  characters. Oversized fields fail explicitly rather than silently corrupting records.
- `batch.read` reads up to 100 rows from a handle and returns
  `{ok: true, value: {records: [...], count}}`, where `count` is the total batch size.
  Check `result.ok`, then iterate `result.value.records`. `batch.release` frees the handle. Each invocation
  can retain eight batches, at most 1 MB each and 4 MB total. There is no silent eviction.
- `emit.batch` validates and emits 1–100 separate packets through the existing event
  pipeline. Every item requires a stable `dedupeKey`. The first rejection stops the batch;
  `accepted` and `failedIndex` describe the partial result. Already accepted events remain
  durable. A replay with the same keys is deduplicated by the normal event pipeline.
- `checkpoint.get` / `checkpoint.set` read/write one progress object per task/input event,
  capped at 16,000 characters. Writes are fenced by the run lease. This survives retry runs;
  a new execution starts with a separate checkpoint. Save stable identities and cursors
  after checking event acknowledgements. Checkpoints and browser effects are not atomic.

Batch handles and anchors expire with the executor/session. Reacquire them after restart.
DOM offsets are not durable cursors for virtualized feeds. Use stable record identities
and accepted event keys to reconcile repeated observations.

## `browser.code`

The tool accepts a module exporting an async function. Its only capability is
`await tools.call(name, args)`, returning the same `{ok, value, error}` contract as direct
tools. It can invoke browser, batch, checkpoint, and emit tools; lifecycle and recursive
code calls are unavailable. Page/network strings remain labelled untrusted data.
`URL` and `URLSearchParams` support URL parsing, relative resolution, query parameters,
and normalization without network access. Their data-only bridge accepts at most 65,536
characters per request, 4 MB of requests and 10,000 operations per invocation; object-URL
creation is unavailable.

```js
export default async function (tools) {
  const batch = await tools.call("page.extractBatch", {
    selector: "article",
    fields: { url: { selector: "a", attr: "href" }, text: { selector: ".body" } },
    limit: 25,
  });
  if (!batch.ok) throw new Error(batch.error);
  const data = await tools.call("batch.read", { batchId: batch.value.batchId });
  if (!data.ok) throw new Error(data.error);
  const records = data.value.records.filter(row => row.url);
  for (const row of records) row.url = new URL(row.url, "https://fixture.test").href;
  if (!records.length) return { accepted: 0 };
  const emitted = await tools.call("emit.batch", {
    type: "item.found", // Must be declared by this task, with a matching packet schema.
    items: records.map(packet => ({ packet, dedupeKey: packet.url })),
  });
  if (!emitted.ok) return { partial: emitted.value, error: emitted.error };
  await tools.call("checkpoint.set", { value: { lastAcceptedUrl: records.at(-1).url } });
  await tools.call("batch.release", { batchId: batch.value.batchId });
  if ((await tools.budget()).remainingMs < 5000) await tools.yield();
  return { accepted: emitted.value.count };
}
```

Programs run in a fresh isolated-vm isolate: 32 MB, up to 30 seconds of active wall time,
50 host calls, 24,000 source characters, and an 8,000-character return summary. There is
no filesystem, process, independent HTTP client, imports, or arbitrary in-page JavaScript.
Concurrent guest calls are serialized. Cancellation and termination fence queued calls;
an in-flight browser effect may already have happened and must be reconciled, not blindly
replayed. `tools.budget()` reports remaining wall time/calls and `tools.yield()` stops further
calls. Admission yields with five seconds remaining (one fifth of shorter custom deadlines)
and before exhausting the call budget. Process batches of at most 25 records and return
short summaries between batches.

`code.status` exposes the durable effect journal. Each accepted batch item is checkpointed
by index and stable key hash; the event bus retains full dedupe keys. A deadline drains admitted
host work for up to five seconds. Settled wall-clock expirations can return a resumable yielded
result. Unsettled effects or CPU/memory failures remain terminal. Ambiguous action outcomes
block another code invocation until the destination is inspected and `page.verify` succeeds;
recovery never blindly replays an external write. Only queued calls are guaranteed cancelled.

Nested tool calls and code outcomes are traced as metadata; raw program source and
extracted content are not copied into the default trace. Emitted packets retain the
normal durable event record. Code execution is exploratory and does not itself promote
the task to a compiled script.

The browser contract is recorded as `tabductor-static-v3`; scripts compiled against
the previous runtime fall back to AI before execution and must be recompiled for reuse.

## Regression checks

The TypeScript batch/code tests cover 100 records, partial validation failures, cancellation,
context bounds, takeover and isolation. `tests/system/browser-batch-code.test.ts` validates
100 real browser extractions and durable, deduplicated database emissions. Run the real
Camoufox contract separately from fake-browser protocol tests:

```sh
docker run --rm --network none \
  -e TABDUCTOR_PERCEPTION_SCRIPT=/shared/perception-script.js \
  -v "$PWD/apps/browser-worker:/worker:ro" \
  -v "$PWD/packages/browser/src/perception-script.js:/shared/perception-script.js:ro" \
  --entrypoint python tabductor-browser-worker:local tests/test_browser_contract.py
```

## Snapshot observations and exploration

Both drivers evaluate `packages/browser/src/perception-script.js`. The worker image copies
that exact asset; the real Chromium and Camoufox suites share an HTML contract fixture.
Observations include visible controls, headings, containers and open shadow roots, accessible
labels, input state (never password values), disabled/checked/selected/expanded/focused
state, viewport bounds, parent anchors and selector hints. Closed shadow roots remain
inaccessible. Child frames are listed explicitly; pass `frameId` to inspect one. Frame lists
also paginate with `frameOffset` / `nextFrameOffset`.

Every observation has a session-unique `snapshotId`. Its anchors include that ID, and the
session resolves them to stable node identities rather than a positional selector. An old
anchor is rejected after a refresh or action; identical element numbering cannot retarget a
queued click. Semantic selectors are retained separately for compiler evidence. Never store
anchors in checkpoints. Acquire the fresh `scopeAnchor` when paging a scoped inspection.

`page.perceive`, `page.find` (literal text/name or role), and `page.inspect` (an anchor's
subtree) accept `elementOffset`, `elementLimit`, `textOffset`, `maxChars` and `frameId`.
`nextElementOffset` and `nextTextOffset` describe omitted content. The 20,000-character
requested text budget is preserved; the serializer reduces the number of returned elements
to fit a 28,000-character observation instead of silently replacing it with a short preview.
A 50,000-node scan ceiling is explicitly reported as `scanTruncated`; use scoped inspection
when coverage is incomplete. DOM offsets describe this observation, not durable cursors.

Browser executors obtain an initial observation before the first model call. Each completion
carries native assistant tool-call parts and matching tool-result parts, preserving call IDs.
Discarded calls receive explicit non-execution results. External content remains labelled
untrusted. Superseded snapshots are removed from a multi-call result while action outcomes
are retained. Oversized generic results preserve their original success/failure status and
explicitly report omitted data; use batches/code for bulk data. No raw DOM HTML is supplied.

`page.screenshot` provides actual image content to the model. It captures the viewport or
an anchor crop (up to 4 megapixels and 1 MB); older images are removed from subsequent
requests once a new turn completes. Screenshots follow the existing screenshot storage flag.
Model admission includes an estimated image allowance, system instructions and tool schemas.
`limits.agent.max_input_tokens` overrides the default 32,000-token admission budget. This
is a conservative harness estimate, not a provider-specific context count or billing usage.
The 4 MB serialized-request limit still applies.

## Interaction and completion

The agent also has `page.press`, `page.select`, `page.hover`, `page.drag`, targeted and
horizontal `page.scroll`, and `page.dialog`. Dialog policy is one-shot: arm accept/dismiss
before triggering a dialog; dismiss remains the default. Human takeover clears armed policy.
`tabs.list` / `tabs.switch` expose only the current run's root tab and owned popups, respecting
other tasks' tab ownership. Switching produces fresh perception.

`page.download` retains up to four 1 MB files outside model history. `file.read` reads a
bounded text slice, `file.release` frees a handle, and `page.upload` accepts a retained file
or bounded inline base64. Upload/download use the existing action policy gates. Handles expire
with the executor; no filesystem paths are exposed to the model or code isolate.

Browser `done` requires a successful `page.verify` against the current snapshot. Verification
supports URL/text conditions and anchored value/checked/selected/expanded/disabled state.
Incomplete text coverage cannot establish absence. A later action or fresh snapshot makes the
check stale, including human takeover. The model must choose conditions that match the task;
this is an observable assertion, not an independent proof of business correctness. Repeating
the same action without an observed change is stopped and asks the model to inspect another
target. A changed observation permits recovery.

## Exploration memory and compiler evidence

AI browser runs, decision runs and AI recovery from compiled scripts have no fixed model-turn
limit. Legacy `limits.agent.max_steps` values are ignored; existing workflows do not need
republishing for this change. Runs continue until `done`, `fail`, cancellation, a deadline or
another execution error. Context compaction, repeated-target guards and per-invocation
`browser.code` limits remain active. Traces still record the number of turns at completion.

`memory.set` saves compact observed facts and pending work. `memory.get` also includes
recent attempts, failures and acknowledged effects, maintained by the harness. This memory
is durable for retries of the same run and is included alongside the checkpoint during
compaction. It does not expose another workflow node's conversation. Accepted event packets
remain the durable cross-node handoff. Truncated acknowledgement summaries are marked as
such; event deduplication and checkpoints still govern reconciliation.

Default traces now retain bounded structural observation metadata, coverage and extraction
field selectors, without copying page text, form values or image bytes into metadata. The
compiler receives these fields as evidence. The runtime contract is `tabductor-static-v3`;
older compiled artifacts fall back to AI. Runs using interactions the static compiler cannot
yet reproduce remain in AI mode with an explicit compilation refusal, rather than promoting
a script that silently omits those actions.

Run the shared real-browser worker checks with the source asset mounted explicitly:

```sh
docker run --rm --network none \
  -e TABDUCTOR_PERCEPTION_SCRIPT=/shared/perception-script.js \
  -v "$PWD/apps/browser-worker:/worker:ro" \
  -v "$PWD/packages/browser/src/perception-script.js:/shared/perception-script.js:ro" \
  --entrypoint python tabductor-browser-worker:local tests/test_browser_contract.py
```

## Record outcomes and completion

Declare record identity and stage on each record event (omit this metadata on control and
summary events):

```json
{
  "type": "tweet.extracted",
  "description": "tweet_id is a required stable string; replies_count is integer or null when unknown",
  "record": { "collection": "tweets", "key": "tweet_id", "status": "extracted" }
}
```

Use the same collection and stable identity field throughout the route, with stages
`extracted`, `prepared`, `pending`, `saved`, `skipped`, `rejected`, or `failed`. Publication
requires a non-null string/integer key and rejects shared fields that narrow nullability,
make unknown optional values mandatory without permitting null, or change type. Schema
compilation no longer requires every optional observation or substitutes zero/false for unknowns.

Publication checks generated schemas together before compiling task prompts. If independently
generated events disagree, the compiler supplies the rejected output, all its compatibility
errors and its upstream schemas to a bounded repair pass. Repairs preserve declared fields,
propagate through branches and downstream outcomes, and may also update cached downstream
schemas when an upstream contract changes. Each event gets at most two repair attempts;
unresolved conflicts still reject publication atomically with per-event diagnostics. A nullable
raw identifier can remain unknown while a separate derived deduplication key stays required.

Every real decision receiving a data packet must produce an acknowledged output or use
`record.outcome` with a disposition and reason. Silent `done` is refused, including on legacy
published decisions. Rejected records remain visible with reasons. Engine completion and
watchdog failures also enforce the disposition; model compliance is not the only safeguard.

To count a saved record, the browser must use `page.verify` with `recordKey` equal to the
input's stable identity and `urlIncludes` naming its destination. That identity must appear
in the current observation's text, URL, or element value. Then `record.outcome` with `saved`
records the snapshot, identity, URL and timestamp. A saved event without this matching proof
is rejected. This is observable evidence chosen by the model, not an independent audit of
the destination's durability or semantics. Verification must target the completed destination
record, not a form whose submission is still pending.

The record ledger is keyed by execution, collection and identity. Duplicate events do not
multiply counts or erase verified saves. Status polling, MCP results, finalizer context and
the workflow view expose total tracked records plus separate extracted-awaiting-preparation,
prepared, pending-save, saved, skipped, rejected and failed counts. A quiet execution with
pending, rejected or failed records cannot be marked successful. Task success is never a
substitute for a destination save. Older executions without record contracts explicitly show
tracking as unavailable; their historical counts are not fabricated.

Record-aware browser workflows stay in AI mode until the static runtime can reproduce
record verification and disposition. Republish existing workflows to install the new record
metadata and regenerate nullable schemas and prompts. Existing published versions and
historical runs are not rewritten by these source changes.

## Prerequisite blocks and errors

The production engine checks the pinned workflow's model selection, active account/provider
credential reference, platform provider/rate configuration and browser service before starting
a run. This checks local configuration, not provider-side API-key validity. Hosted admission
uses controller health (including fleets with zero warm workers), ready worker health as a
fallback, and profile ownership. Local admission requires a healthy configured endpoint.
Actual capacity acquisition remains fenced by the existing allocator and leases.

Missing prerequisites persist as workflow/execution block reasons. Runs wait in the queue
without consuming a run deadline or calling a model, with checks spaced 30 seconds apart.
Scheduled fires check prerequisites before creating any execution. Resolving the prerequisite
lets queued work proceed and future scheduled fires resume; skipped schedule occurrences do
not accumulate a backlog. Persisted workflow blocks are also rechecked every 30 seconds when
there is no queued run, so repairing configuration does not require waiting for the next
scheduled fire. Existing pinned model choices remain pinned.

Worker command errors expose stable codes for revoked control, stale/ambiguous targets,
obstruction, timeout, disconnection and invalid arguments. Browser call logs and typed values
are omitted. Known rejections and uncertain outcomes are recorded separately. Action errors
do not disconnect the whole session. Two failures on the same resolved target stop further
attempts until a changed observation or another target provides a recovery path.

Audit-derived regression coverage is in `workflow-record-progress.test.ts`,
`workflow-prerequisites.test.ts`, `browser-tab-pool.test.ts`, `browser-session-control.test.ts`,
`control.test.ts`, `browser-context.test.ts`, `tool-script.test.ts`, and worker fencing tests.

## Activating these changes

Apply database migrations `0043_breezy_jack_power.sql` and `0044_broad_skaar.sql` through the
normal migration runner, then deploy the updated engine, fleet, browser worker and web
services. Republish existing workflows to add record contracts and regenerate schemas and
prompts. Source changes alone do not update running containers or published workflow versions.
