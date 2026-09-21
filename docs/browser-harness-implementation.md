# Browser harness implementation

Implemented September 20, 2026, from [the five-part design](browser-harness-intent-and-execution-design.md) and [the session audit](browser-harness-audit-2026-09-20.md).

## Behavior now implemented

| Design change | Implementation | Operational effect |
| --- | --- | --- |
| Preserve intent | `engine/intent-contract.ts`, `graph-authoring.ts`, `graph.ts`, `prompt-compiler.ts` | The host binds the original request and digest. Quotes, requirement coverage, task roles, destination readiness paths and record transport are validated. Authoritative task instructions are rendered without an extra model completion. Relevant intent and policy changes invalidate hashes. |
| Separate namespaces | Intent renderer and graph authoring instructions | Packet names and internal store columns no longer imply website property names. Destination preparation can reuse properties or page-body storage, with scoped additive setup unless the original constraints prohibit it. Unknown source values remain unknown. |
| Prepare once | `engine/destination-contracts.ts`, `agent/destination-tools.ts` | Setup ownership is durable and fenced. A validated immutable mapping and its readiness event commit together. Source tasks consume readiness; every record carries a contract reference. Writers cannot load another execution's mapping. |
| Deterministic bookkeeping | `engine/record-processing.ts`, event emission and destination admission | Fixed normalization operations run before validation and event publication. Duplicate records are suppressed transactionally. A workflow/destination ledger prevents another browser invocation for an already verified identity, including subsequent executions. Concurrent writers wait for the owner without invoking a model. |
| Browser execution and recovery | Shared perception script, agent tools/loop, human-action lifecycle | Focused editors and overlays precede dense sidebars. Observations are smaller and stale snapshots leave model history. Repeated interaction cycles are bounded. Writes require identity and required content evidence outside an active editor. Human requests persist and suspend the executor until explicit resume. |

## Graph and task contracts

New graph authoring returns `graph.intent.requirements`, exact source quotes, optional supported constraints, and an optional quantity contract. The host supplies `version`, `originalRequest` and `requestDigest`; the model cannot bind those fields itself. Empty requirement sets, invalid quotes and uncovered requirements fail the graph gate.

Tasks declare `limits.harness` with version 1, a role, and their requirement IDs. Supported roles are `source`, `prepare-destination`, `write-record`, and `semantic`. Browser roles require browser tasks. Destination tasks additionally declare:

```json
{
  "url": "https://destination.example/database",
  "contractField": "destination_contract_id",
  "requiredFields": ["body"],
  "identityField": "stable_identity",
  "readyEvent": "destination.ready",
  "setupTask": "prepare-destination"
}
```

The destination URL must occur in the original request. Setup, source and writer contracts must agree. A source with this contract cannot also be an entry: it waits for the declared readiness event. A writer consumes record events, with a matching declared identity, from a source gated by readiness. Subscribing the writer separately to readiness is rejected as an implicit join.

Readiness has an engine-owned schema containing only the contract reference. Record schemas must transport that reference, the stable identity and required content. The graph gate rejects a missing path before browser execution. Requirement interpretation remains a model responsibility: these mechanical checks establish provenance and consistency, not semantic equivalence of arbitrary natural language.

The prompt renderer carries the original request and relevant requirements into each task. It does not append unrestricted model-generated operating instructions or neighboring task prose. Native tool definitions carry parameter schemas; the runtime does not repeat their complete descriptions in system text. `llmPromptCompiler` remains as a compatible factory name but performs zero model calls.

## Destination lifecycle

1. Before setup acquires a browser, the engine claims `(execution, destination)` in `destination_preparations` using the current run fence. A concurrent setup defers. A previously ready setup returns without rediscovering the destination.
2. The setup observes the current database, chooses storage locations for required content and identity, and performs any permitted additive changes through ordinary browser tools. Those external effects are not part of a PostgreSQL transaction.
3. `destination.contract.publish` obtains fresh browser evidence. The host checks the canonical destination, observed labels, complete content mapping, identity and verification fields, and preparation ownership.
4. The immutable row in `destination_contracts`, the ready preparation state, the readiness event and its outbox entry commit atomically. Setup cannot report success without this publication.
5. Source events receive the host-bound reference. `destination.contract.read` accepts only that trigger's reference in the same execution and authorized destination.
6. Writers reuse the mapping. They reconcile the destination for the triggering identity before creating a row, read back the content after committing it, and record a verified outcome.

Notion database IDs are recognized independently of title slugs and view parameters. Unknown sites retain their origin, path, query and fragment because those may identify different databases. A writer on a record page must observe the authorized database URL or a matching breadcrumb/link.

Revision 1 is immutable for an execution. Conflicting publication returns `destination_schema_drift`; the operator starts a new execution with a fresh preparation. Automatic in-execution schema revision and re-routing of in-flight records are not implemented. This avoids silently changing the meaning of an already-issued reference.

## Record lifecycle

`limits.recordProcessing` configures versioned fixed operations, not arbitrary server code:

```json
{
  "version": 1,
  "eventType": "record.ready",
  "identityField": "stable_identity",
  "sourceIdField": "tweet_id",
  "sourceUrlField": "url",
  "contentFields": ["body"],
  "trimFields": ["author"],
  "nullableFields": ["likes"],
  "canonicalUrlFields": ["url"]
}
```

Source IDs are retained when present. A separate identity is derived from a namespaced source ID, canonical source URL, or a configured content fingerprint. An optional `sourceNamespace` can explicitly distinguish sources. No derived value is written into a source-provided ID field. Missing required content fails normalization; configured unknown optional fields become null.

Normalization precedes event-schema validation. The stable identity claim, event, outbox and execution progress commit together. Source deduplication is scoped to the execution. The destination ledger is scoped to the workflow and canonical destination and therefore survives execution/version changes.

Before a writer acquires a browser, its ledger claim is fenced by run ID and lease generation. Another active owner causes an engine-only deferral. A saved row produces a skipped disposition with no writer model call. A failed/crashed owner's pending row can be reclaimed, but the writer must inspect the website before replaying uncertain effects.

`record.outcome(saved)` requires verification for the exact input identity, current destination contract and committed content. The ledger and execution outcome update in the same internal transaction. Repeating the same saved disposition is idempotent. External browser actions remain non-atomic: this does not promise exactly-once website writes, or deduplication across unrelated workflows.

Quantities retain their declared measurement point (`source-records`, `unique-records`, or `verified-saves`). A fetch target is not silently converted into a target for new saves. The collector still owns enforcing its collection target and reporting source availability; this implementation does not infer a reliable fetch count from arbitrary scrolling.

## Browser behavior

- Perception ranks focused controls, overlays, viewport content and the main work area before paging. It crosses open shadow-root boundaries and ranks native options using their select control. Exact-node anchors retain their existing mutation fencing.
- Empty placeholder attributes no longer hide contenteditable-specific placeholders. Contenteditable values are visible to the agent. Observation serialization omits null/default metadata and duplicate text/name values.
- Superseded DOM snapshots are removed across conversation turns while action results and errors remain. Durable memory is keyed by the trigger so retries retain failed approaches and acknowledgements.
- A 24-mutation ring detects cycles of length 2–6 repeated three times, ignoring intervening read calls. Semantic target descriptions make recreated editor nodes comparable while actions still target exact observed nodes. Repeated guard violations terminate with `agent_no_progress` instead of spending an unbounded sequence of model calls.
- Click/fill actionability waits are capped at five seconds in both drivers. Explicit hosted waits are capped at 120 seconds and get a transport deadline at least ten seconds longer, avoiding the previous 120-second browser wait behind a 60-second transport timeout.
- Destination verification checks identity and all required mapped values. Active editors and input values cannot establish committed text evidence. Unfocused persistent rich-text blocks remain readable. This is browser-observable evidence, not a proof of remote storage durability; write instructions require reconciliation and committed readback.

## Human handoff

`human_action.request({ reason, resumeWhen })` writes a durable request, moves the run to `awaiting_human`, revokes automation input, and releases the executor. The execution remains open. Other tasks sharing that browser obey its existing session-wide pause.

Only a durable request sets `browser_sessions.human_action_pending`. Ordinary takeover expiration keeps its existing behavior. The authenticated explicit browser-resume operation requeues waiting runs; `startRun` supplies a new fence. The worker still acknowledges the input generation and the agent reacquires fresh perception. A process restart does not turn a human wait into a failed or successful run. Trace numbering continues when the same run resumes.

The runs table includes the new status and permits cancellation. Existing session activity exposes the reason and resume condition. No model polling occurs during suspension.

## Compatibility and rollout

Apply migrations `0045_intent_destination_harness`, `0046_durable_human_control`, and `0047_destination_preparation_ownership` before starting the updated engine/web/fleet processes. Rebuild the browser worker because it consumes the shared perception script and action timeout changes.

Legacy published graphs retain their execution-pinned versions. Re-author and publish a new version to gain intent contracts, destination preparation and deterministic record processing. There is no automatic rewriting of active workflows or assumption that the audited Notion session made no partial writes.

New contract tasks stay on the fenced agent runtime; background script promotion skips them until the compiled runtime supports these destination capabilities. Legacy script promotion, replay and recovery remain supported and tested.

Migrations were applied only to isolated test databases during implementation. The running application and session `session_2fa5d83d-72b3-4e97-a7bf-fb84b8c66bf7` were not restarted, republished or replayed.

## Validation

The implementation adds unit checks for intent/provenance, zero-call prompt compilation, stable identity normalization, canonical destination identity, alternating UI cycles, and required-content verification. PostgreSQL integration checks cover setup ordering, atomic readiness, cross-execution reference rejection, source dedupe, cross-execution saved-record skipping, concurrent writer fencing, missing-readiness failure and durable human suspension/resume. Trace tests cover appending after resume.

Real Chromium fixtures exercise a portal contenteditable after 450 sidebar controls, draft rejection and committed readback. The shared worker contract is also tested in a network-disabled Camoufox container. Existing batch collection, retained tabs, replay, compilation and recovery tests are retained.

Useful commands from the repository root:

```sh
rtk proxy pnpm run build
rtk proxy pnpm exec vitest run packages/engine/src/intent-contract.test.ts packages/agent/src/interaction-progress.test.ts
rtk proxy pnpm exec vitest run tests/system/intent-harness.test.ts tests/system/browser-exploration.test.ts tests/system/browser-session-control.test.ts --maxWorkers=1 --no-file-parallelism
```

The broad unit run exposed three existing `apps/web/src/lib/profile-extension.test.ts` loader failures (`Cannot use import statement outside a module`) against the workspace's separately modified extension. Those are outside this implementation. Live model graph-generation quality and the real Notion workflow still need an explicit live evaluation; fixture results are not a measured live speedup.
