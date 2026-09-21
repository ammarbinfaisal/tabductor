Historical workflow failure audit — 19 September 2026

The local history shows failures at several layers: browser allocation, input ownership, workflow schemas, agent exploration, and completion reporting. The most recent X → Notion workflow has no confirmed destination saves across 19 executions. Better perception addresses part of this, but the remaining orchestration and workflow-contract problems need separate fixes.

This audit used read-only queries against the local `tabductor` database. The main snapshot was captured at **2026-09-19 12:47:27 UTC / 18:17:27 IST**, covering runs from 23 August through 19 September. It contains 4,429 task runs, 329 workflow executions, 425 browser sessions, 25,472 trace entries, and 1,300 model-operation records. Detailed inspection covered 796 events from X → Notion and its earlier `kok` workflow, 4,290 browser commands, public session activity, compiled task prompts, input packets, and recording metadata. Two available recording frames were decrypted and inspected locally; both showed a rendered, authenticated X feed. Private recording intervals were not accessed. Staging history was not included.

Only this report was added. No workflows were triggered, configuration changed, sessions resumed, or services deployed.

The overall counts require separating stub runs, individual tasks, and completed workflows:

| Population | Succeeded | Failed | Timed out |
| --- | ---: | ---: | ---: |
| Stub task runs | 544 | 0 | 0 |
| AI task runs | 258 | 3,624 | 3 |
| AI browser tasks | 27 | 3,615 | 0 |
| X → Notion workflow executions | 0 | 19 | — |

Of the 3,627 failed or timed-out tasks, **3,139 report `no_endpoint_configured` and 236 report missing model selection**. Together those account for 93.1% of failures. Most belong to the old scheduled `abc` workflow. These repeated prerequisite failures would distort any aggregate measure of browser-agent reliability. The latest stored `abc` run still failed on missing model selection at 12:45 UTC.

For workflow `wf_0b26369d-2383-4c5a-9195-b848f409c9e4` (`x.com > notion`), the 377 tasks break down as follows:

| Task | Succeeded | Failed |
| --- | ---: | ---: |
| Collect tweets | 1 | 18 |
| Prepare tweet for saving | 177 | 0 |
| Save tweet into Notion | 0 | 162 |
| Produce workflow summary | 16 | 3 |

The 194 successful tasks here do not establish workflow success: 177 were preparation tasks and 16 were summaries of failed executions. There are no recorded `notion.tweetUpsertSucceeded` events.

1. **The largest recent failure was allocating a browser session for each destination packet.**

   Execution `exec_73610af2-d2fd-4700-8a28-2bfe47bd6b12`, started at 07:41:29 UTC, emitted 100 distinct tweet IDs. It produced 85 destination requests; all 85 writers failed with `browser capacity did not become available in time`. This one execution created **86 sessions sharing one profile; only one ever became ready**. Representative writer `run_ed543e50-cc63-4e5c-8c52-5ddc03a56b5c` waited approximately 120 seconds and failed without any browser trace.

   Execution `exec_c74a70fd-406a-4a48-9ab0-894c68cb2e9b`, started at 09:34:03 UTC, repeated the pattern: 63 extracted records, 63 destination requests, **64 sessions sharing one profile, one ready**, and 63 destination allocation timeouts. These two executions explain 148 of the workflow's 152 capacity failures; the other four affected collectors.

   This strongly supports profile-lease contention as the cause. The fleet excludes queued allocations whose profile already has a lease. Creating more sessions for that profile cannot provide simultaneous access. The current source now has `ensureExecutionBrowserSession` and reusable tab leases; later executions at 10:49 and 11:16 used one session each. That is an observed architectural improvement, although neither execution completed the destination work. Allocation request terminal statuses were all `cancelled` when inspected, including sessions that had been ready, so those statuses alone cannot reconstruct allocation history.

2. **Fifteen tweets disappeared through an explicitly permitted successful no-op.**

   In the 100-record execution, 15 preparation tasks returned `done` without emitting either `notion.tweetUpsertRequested` or `tweet.skip`. Checking their trigger packets explains the split: **10 had neither extracted tweet text nor media URLs; five had null engagement counts**. All had tweet IDs. This was not a within-batch duplicate problem: all 100 emitted IDs were distinct.

   The stored compiled prompt for `task_653f1af4-a23a-4460-bde9-4fb05b4291a9` explicitly directs the normalizer to finish without emitting when content is insufficient. It also says the output schema requires integer engagement counts and a boolean quote/repost field, then directs it to finish without emitting if these remain null. The authored task permits unknown values; the generated downstream contract does not. `tweet.skip` only permits `already_saved`, leaving no typed rejection outcome for these cases.

   Examples: `run_76251d28-02df-4fd1-97b6-8915f35a34ee` received an empty-content record and called `done` on its first model turn; `run_a5cecabb-33d7-4f77-8460-a1e2445a27b2` received nonempty text with a null reply count, queried the store, then finished without emitting. The trace records no model explanation, but the input conditions and stored prompt account for all 15 omissions.

   Required change: validate schema compatibility across edges before publication, preserve unknown optional measurements, and give every processed item an observable outcome such as prepared, already saved, rejected, or failed. Count usable records and confirmed saves separately from distinct extracted IDs. Browser `page.verify` does not enforce this decision-task contract.

3. **Human takeover and resume could terminate useful work or consume the entire model budget.**

   Six X → Notion tasks terminated with worker HTTP 409 `input ownership was revoked`: four during `page.perceive`, two during `browser.version`. In the final execution, `automation_resumed` was recorded at **11:19:58.698 UTC** for input generation 4. Two perception commands became uncertain within about 160 ms; a new writer's `browser.version` failed shortly afterward. Collector `run_554f71f4-ba2b-454b-b821-00e02abca7f9` had already extracted four records before this transition.

   Source inspection supports a resume race: `resumeBrowserAutomation` publishes AI ownership in the database, while the fleet sends the control generation to the worker asynchronously. Automation can resume from database state before the worker acknowledges that generation. Additionally, the Camoufox driver wraps non-success HTTP responses as plain `Error`, whereas loop recovery recognizes typed `AppError` control-transition codes. Session initialization calls `browser.version` before the loop's control wait is installed.

   Earlier collector `run_c43c1f92-c3e4-4bbb-8b0f-cfcadd100bfc` used all 30 model turns amid repeated paused-input failures. Its trace has 35 failed perception actions. The v3 loop's control waits improve this behavior, but they do not by themselves add a worker acknowledgement barrier or typed HTTP-409 decoding.

   Required change: acknowledge control generations before admitting automation, preserve typed control errors across RPC, and cover session initialization as well as in-loop actions. Resume tests should overlap X and Notion tasks, with a command already in flight.

4. **The code tool's wall-clock limit killed collectors after acknowledged progress.**

   All three `resource_limit_exceeded` failures in X → Notion ended with a `browser.code` trace whose outcome was `killed`. The elapsed times from the corresponding model response to termination were **30.261, 30.174, and 30.110 seconds**, after 42, nine, and three host calls respectively. The collectors had emitted 63, five, and five records.

   Evidence: `run_60332951-b76e-446b-8204-828ef3d2c06d`, trace #1845; `run_933e4051-293c-46db-9042-621fb644d517`, #291; `run_daad916e-a38e-4eb5-b954-42d1d40c744d`, #350. The last case shows that even three browser operations can exhaust the time budget. The timings strongly indicate the wall-clock limit; the stored `killed` outcome does not independently distinguish time from memory exhaustion.

   Current code converts a killed invocation into a permanent run failure. That prevents a racing retry while a browser effect may still be in flight, but also ends collection despite durable progress. Required change: expose remaining budget, make collection chunks smaller, and support a resumable yield after in-flight work has settled and acknowledgements are reconciled. Simply catching the timeout and replaying the last chunk would risk repeating effects.

5. **Notion writers spent their budget exploring capped observations and retrying opaque click failures.**

   The three later Notion writers that reached `step_budget_exceeded` used 30 model turns each. `run_216bcc79-e860-4dfd-83dd-85b776a33d74` made 13 explicit perception calls and six click calls, four of which failed. `run_83a2054e-9259-4381-96b6-94bdbb8f236c` made 14 explicit perception calls and six clicks, three of which failed. `run_571548ec-f375-4a2b-8c42-f1611322b138` made ten explicit perceptions and eight clicks, five of which failed. These counts exclude automatic perception after actions.

   Across the recent workflow, **225 of 306 successful perception actions returned exactly 300 elements**, the old extractor ceiling. Across six runs there were **16 click failures reported only as HTTP 500 `Internal Server Error`, costing 483 seconds in total**. Several repeated the same unversioned `e5` selector. In the three writers above, twelve failed clicks consumed about six minutes combined. Traces cannot establish which historical DOM nodes those numbered anchors represented or whether they had been replaced.

   The new scoped search, paging, stable node identities, screenshots, and richer state directly address exploration and targeting weaknesses. A remaining gap is structured worker errors: distinguish missing, stale, obscured, disabled, strictness, and timeout failures from a disconnected browser, and return the relevant observed target state. The current no-change guard should also be tested against repeated failed actions, not only successful actions with unchanged observations.

6. **Older runs sometimes labelled a usable page unavailable and still finished successfully.**

   In `run_4d6ef0ad-a2fa-4ec6-a3ad-da91b726f406`, the timeline rendered with 282 elements and 2,226 text characters. Extraction then failed because a Playwright selector, `span:has-text(...)`, was passed to native DOM `querySelector` (#244). The agent immediately emitted `x.page_unavailable` (#249) and called `done` (#255). The run is stored as succeeded.

   In `run_0cdcfc33-626e-4a80-91fd-0f32d58c17ee`, perception showed 300 elements and 2,916 text characters (#248). The agent then waited on a `main:text-is(...)` selector containing the changing timeline's entire text, treating it as the “For you” tab. It timed out (#327), emitted `x.page_unavailable` (#333), and finished successfully (#341).

   Shared extraction semantics, container roles, better names, recovery guidance, and observable completion checks address these specific classes. Historical task success still needs to be interpreted alongside emitted business outcomes; an event reporting page unavailability is not evidence that collection succeeded.

7. **Context and deterministic normalization consumed avoidable work.**

   Two collectors ended with `model input exceeds the configured limit`: `run_13e3a8fe-a17b-4a17-8f80-68b8070afbfd` and `run_6842ba76-88b6-47cd-ba0f-f0bae0c86d13`. Their largest recorded provider input counts were 25,898 and 22,049 tokens respectively. The rejected requests themselves were not retained, so their actual sizes and the exact excess cannot be reconstructed. The new whole-request estimator and compaction address this class, but need live validation.

   Preparation also generated many recoverable store errors: 67 timestamp-alias parse failures, 38 SQLite-style date-function failures, and nine integer/null versus boolean field mismatches in the retained traces. Affected runs ultimately succeeded. Model-operation records attribute **937 successful runtime model calls to decision tasks**, versus 267 to browser tasks and 16 to summaries in X → Notion. Deterministic normalization, a supplied runtime timestamp, and a consistent field type across packets and storage would remove much of this work.

8. **Historical observability is insufficient to reconstruct exactly what the model saw.**

   Only 534 of 4,429 runs have any trace rows; many failures occurred before a browser or model could start. Of the 183 failed X → Notion tasks, 163 have no trace rows. Retained LLM entries contain tool names and usage, sometimes a prompt hash or admission error; they do not contain the actual historical model request or tool-result payload. Perception entries chiefly record counts and URLs. This supports event and action timelines, but not exact prompt replay or a definitive diagnosis of every click.

   Recording also has explicit limits. The recorder intentionally disables capture for the rest of a session after sensitive interaction. The final execution retained about 183 seconds of video although its browser session lasted about 20 minutes; later Notion writer failures are outside that recording. The sampled pre-takeover frame shows the selected X tab, not the background Notion tab. Across the snapshot, 268 ended sessions still have `recording_status=recording`; none has a finalized complete/partial state. The fleet's dead-worker path ends sessions without finalizing recording metadata. This makes the inspector's recording status unreliable after abnormal termination.

   Required diagnostic evidence: structured RPC error codes, snapshot/target identifiers and bounded structural fingerprints, per-turn context size and omission reasons, code termination reason and remaining budget, item rejection events, and a finalized recording coverage manifest. Opt-in redacted model-request capture would make context investigations reproducible without enabling unrestricted page or credential logging.

The code-versus-deployment distinction matters. A read-only check of the running `tabductor-engine-1` container found **`tabductor-static-v2`**, no snapshot namespace in its session wrapper, and no verification gate in its tool registry. Historical runtime entries contain v1 or v2, never v3. The v3 implementation in the workspace therefore has no successful or failed production-history evidence yet. Updating source does not regenerate already-published workflow schemas or compiled prompts.

The next work should be ordered by the failures above:

| Priority | Change | Acceptance evidence |
| --- | --- | --- |
| 1 | Complete and test worker-acknowledged resume plus typed RPC errors | Pause/resume concurrent X and Notion tasks during a command; both continue from fresh snapshots without a failed run or model polling while paused. |
| 1 | Correct and republish packet/storage contracts; require explicit per-item dispositions | The exact historical batch accounts for all 100 IDs; the five unknown-count records remain usable; the ten empty-content records produce explicit rejection outcomes. |
| 1 | Validate reusable browser/tab behavior under the historical fan-out | One browser session, separate X/Notion tabs, serialized writer use, and no per-packet allocation storm for 100 destination requests. |
| 2 | Add bounded, resumable collection chunks and effect reconciliation | A browser operation delayed beyond the code budget preserves accepted events and checkpoint progress without duplicate writes or a blind replay. |
| 2 | Exercise the v3 perception tools on the actual Notion editor after deployment | A destination row is located or created, populated, reread, and acknowledged; then repeat under duplicate input and takeover. Do not use `done` or a created blank row as the save metric. |
| 2 | Stop repeated scheduling on unmet prerequisites and improve diagnostics | Missing endpoint/model produces an actionable blocked state; ended sessions receive complete/partial/unavailable recording status; failures retain a specific cause. |

These are proposed follow-up changes and acceptance checks. This audit did not deploy v3 or rerun workflows against X or Notion.
