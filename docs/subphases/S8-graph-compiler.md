# S8 — Graph compiler: one prompt → checked, versioned graph

**Status:** Implemented (migration `0022`).

S8 is the authoring compiler above the post-execution browser trace compiler. It turns one
plain-language intent into a draft graph, store artifact, and capability proposals. It does
not execute a workflow and it does not compile a trace. Trace compilation remains the S6e
post-execution job described by `../trace-compilation.md`.

## Compilation contract

`packages/engine/src/graph-authoring.ts` owns the framework-independent compiler and gate.
The model authors one coherent structured artifact containing the outputs of P1–P4:

1. P1 topology: nodes, kinds, schedules, events, and emit/consume declarations.
2. P2 node prompts.
3. P3 event descriptions plus store DDL and row-validation table specs.
4. P4 least-privilege grant proposals.

One model response is intentional: event fields and store columns need to be named together.
The passes are independently visible in the report even though they share a structured model
call. The versioned prompt is in `graph-authoring-prompts.ts`, not embedded in the loop.

P5 is a bounded repair loop (three attempts by default). Deterministic failures are returned
to the model verbatim. Provider refusal is terminal. A successful or exhausted repair result
is itself a `self_repair` report entry.

The web composition root supplies the configured Vercel AI SDK provider. Without an OpenAI or
Anthropic key, ordinary manual publishing still works; only conversational graph compilation
is unavailable.

## Deterministic gate

`gateGraphDraft` checks the whole artifact and emits stable named entries:

- `graph_shape`: graph schema, unique task/event identities, no duplicate declarations.
- `kind_constraints`: authorable `ai` mode, schedule rules, and per-kind grants.
- `event_wiring`: emitted types must be declared; unconsumed and external inputs warn.
- `store_ddl`: allowlisted DDL plus a rolled-back scratch-schema apply when a pool is present.
- `table_specs`: AJV compilation and DDL/spec table-column-PK bijection.
- `store_references`: decision/store-write requirements and unused-table warnings.
- `migration_classification`: `none|additive|destructive`; destructive needs confirmation.
- `grant_sanity`: task/resource references, store tables, and baseline stripping.
- `cycles_budgets`: cycles require the workflow hop budget.
- `coherence_lints`: mechanically detectable absent-table references are advisory.

Packet JSON Schemas are still lowered and checked by the existing publish-time EC1 compiler.
The persisted `compile_reports.report_json` therefore contains both the graph-authoring report
and the packet/task publish report rather than creating two competing report records.

## Store publication

A compiled store artifact travels through `publishVersion`. Event compilation and graph-gate
validation finish first; the existing S5g migrator then validates/classifies/applies the store
artifact before the graph version is activated. Additive changes apply automatically.
Destructive changes require `confirmDestructive`; the default drain policy rejects while any
run is queued, running, retrying, or awaiting approval. `forceDestructive` is the explicit
override.

The store data and physical schema remain workflow-scoped and move forward across graph
versions. Every `workflow_versions` row pins the `store_schemas` artifact active at that
publication through `store_schema_id`, including a no-change publication. `store_schemas.version`
is the store migration sequence; it is not the graph version id.

## Grant boundary and versioning

`proposed_grants` rows have `pending|approved|rejected|stripped_by_baseline` status. Runtime
dispatch reads only `task_grants` and the specialized secret/store grant tables. Pending
proposals are inert, including `store.write`: production store tools now pass through
`DatabasePolicyGate`, whose zero-row result is default-deny.

Approval is an explicit tRPC mutation. It re-checks the account baseline transactionally,
copies approved proposals into runtime grant rows, and invalidates an active compiled browser
script when capabilities change. Baseline denial records `stripped_by_baseline`; baseline
approval requirements are carried onto the runtime grant.

On recompile, an identical proposal that was approved in the preceding version carries
forward as approved. Added or changed proposals return to pending; removed proposals disappear.
The UI labels these as added, unchanged, or removed and defaults every new checkbox to off.

`tasks.content_hash` covers kind, prompt, limits, consumed/emitted packet schemas, approved
grants, and the relevant store tables. `content_basis_hash` stores the capability-independent
half so an approval/revocation can recompute the final hash without rerunning a model. An
active script is carried only when that complete hash is unchanged.

## Control plane and UI

The thin tRPC surface is:

- `workflow.compileIntent(workflowId, intent, current?)`
- `workflow.getCompileReport(versionId)`
- `policy.proposedGrants(versionId)`
- `policy.decideProposedGrant(proposalId, decision)`

The workflow surface is one-prompt/conversational authoring. The graph remains internal: the
user sees named checks, migration/behavior impact, and a capability proposal checklist, not a
node or wiring editor. Checked proposals are approved after the version publishes; unchecked
ones remain pending and can be approved or rejected later.

## Verification

The unit gate corpus covers all ten named checks, baseline transformation, repair, exhaustion,
and refusal. System tests cover migration creation, combined report persistence, inert pending
proposals, baseline stripping, explicit approval, approved-grant carry-forward, content hashes,
and production `store.write` default-deny. The full repository build, test suite, and web lint
are the release gate.
