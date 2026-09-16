# S9 — Graph optimizer and self-healing internal workflows

**Status:** Planned after S8.

S9 adds a fourth conceptual component: the **Graph Optimizer**. It is not a node kind, has no
task row, consumes no workflow event, and cannot perform browser, store, secret, or
emit operations. It is a post-execution control-plane worker that reads bounded execution
evidence and occasionally proposes a candidate internal graph version.

Users do not author or repair nodes. The product surface is conversation, observed behavior,
capability approval, and version history. Graphs, events, node splits/merges, predicates, and
store migrations are internal implementation artifacts.

## Three levels of healing

### Level 1 — browser healing (already shipped)

Selector or layout failure → compiled-script deopt → browser agent recovery → post-execution
trace compilation → a newly validated browser script. This changes an implementation artifact,
not graph topology.

### Level 2 — node healing

Repeated struggle within one semantic responsibility can rewrite the internal prompt, split a
task into phases, merge tasks that are inseparable, add normalization, or lower a stable branch
into deterministic logic. The result is still a candidate graph version and passes the complete
S8 gate.

### Level 3 — graph healing

Persistent cross-node inefficiency can rearrange task responsibilities, event declarations,
consume predicates, and the workflow store. The optimizer emits a typed patch against Graph vN;
the deterministic patch compiler produces and gates candidate Graph vN+1.

## Evidence signals

The optimizer works from aggregates and explicit evidence references, never raw unbounded trace
text. Initial signals are:

| Evidence | Candidate |
|---|---|
| browser task deopts frequently | move semantic interpretation out of the browser task |
| decision repeatedly parses the same raw structure | introduce a dedicated normalization decision |
| two decision tasks execute together with equivalent inputs | merge them |
| one task has two independent phases | split it with a typed intermediate event |
| decision repeatedly queries and rewrites the same structure | materialize a store table |
| decision repeatedly evaluates the same status branch | lower it to a deterministic consume predicate |
| two browser tasks visit the same origin/profile sequentially | combine browser work when session/order semantics permit |
| one semantic decision has the same outcome at the configured confidence floor (initially 99.9%) | compile it into deterministic predicate/program IR |

“Frequently,” “repeatedly,” and “99.9%” are computed over explicit rolling windows with minimum
sample sizes. Thresholds are versioned optimizer policy, not prompt prose. A signal is evidence
to investigate, not proof that a rewrite is safe.

## User complaints

A user can complain about a run in chat. The request stores the text plus selected run/version
references as an `optimization_request`; it does not paste arbitrary history into an executor.
The optimizer prioritizes that evidence window, explains the behavior-level change it proposes,
and produces the same typed candidate as an automatic signal. Complaints do not bypass the gate,
capability approval, migration policy, or validation budget.

## Candidate patch IR

The model never writes a replacement `graph_json`. It returns a zod-checked discriminated list
whose initial operations are:

- `rewrite_task`: replace one internal responsibility/prompt.
- `split_task`: replace one task with two or more tasks plus typed intermediate events.
- `merge_tasks`: replace compatible tasks and rebind their declarations.
- `insert_normalizer`: put a decision task and normalized event between producer and consumers.
- `combine_browser_tasks`: combine sequential same-session browser work.
- `add_store_table` / `alter_store_table`: produce DDL and table-spec deltas.
- `materialize_store_flow`: bind decision readers/writers to a table.
- `set_consume_predicate`: attach safe expression IR to a `(consumer,event)` declaration.
- `compile_decision`: replace an empirically stable branch with bounded deterministic decision IR.

Every patch names `base_workflow_version_id`. References resolve against that exact version;
duplicate/missing refs fail. Applying a patch is a pure deterministic transform producing a full
graph and full store-schema artifact. No operation contains executable JavaScript, raw runtime
SQL, or an implicit grant.

Illustrative wire form (the actual zod schema closes every operation and identifier field):

```json
{
  "base_workflow_version_id": "wfv_17",
  "operations": [
    {
      "op": "split_task",
      "task_ref": "browser_4",
      "into": ["browser_9", "asset_10"]
    },
    {
      "op": "insert_normalizer",
      "source_event": "invoice.raw",
      "normalizer_ref": "asset_10",
      "output_event": "invoice.normalized"
    },
    {
      "op": "add_store_table",
      "table": "normalized_invoices"
    }
  ]
}
```

The model proposes architecture in this IR. The runtime validates and applies architecture;
the model never mutates `graph_json`, store metadata, or a live workflow directly.

## Verification and publication

Candidate processing is:

1. Re-read the pinned base graph, compiled schemas, approved grants, and pinned store schema.
2. Apply the typed patch in memory.
3. Run all S8 graph/store/grant checks on the full result.
4. Classify the store migration and compute capability/proposal diffs.
5. Replay or shadow the candidate against the bounded evidence corpus. Browser behavior uses
   isolated validation; predicate/decision IR is checked against historical input/output pairs.
6. Reject if the base version is no longer current (optimistic concurrency), then re-optimize.
7. Publish through the ordinary publication path; never update a live graph in place.

Every graph publication pins a complete store-schema version. A candidate that changes the store
therefore carries the full target DDL/spec, runs the ordinary `none|additive|destructive`
migration classifier, and activates only with the new graph version. Store data moves forward;
the schema artifact is versioned.

Automatic healing is allowed only when all of these hold: no capability widening, no baseline
change, migration is `none` or additive, the deterministic gate passes, shadow/replay checks pass,
the base remains current, and the workflow has automatic optimization enabled. Capability
widening, destructive migration, public-output changes, or ambiguous semantic changes create a
held candidate requiring explicit user approval. Rollback publishes the prior internal graph as
a new version; physical destructive store rollback is never inferred.

## Data model and jobs

S9 adds:

- `optimization_requests`: user complaint or automatic signal, evidence/version refs, status.
- `optimizer_jobs`: claim/retry/timeout state, pinned base version, reason and evidence window.
- `graph_candidates`: patch JSON, full compiled artifact, behavior summary, gate/report JSON,
  capability diff, store migration diff, validation outcome, status
  (`proposed|validated|held|published|rejected|stale`).
- aggregate evidence keyed by `(workflow_version_id, task_ref, signal, window)`; no prompt/page
  bodies in metric labels.
- versioned safe consume-predicate and deterministic-decision IR attached to internal task
  consumption records.

The optimizer has a cooldown and one live job per workflow. It never runs inside an execution's
timeout or transaction, and a failed optimization cannot change the completed run that supplied
its evidence.

## Required tests

- One fixture per evidence signal, including minimum-sample and confidence boundaries.
- Patch schema rejects replacement graphs, unknown refs, executable code, raw DML, and grants.
- Split/merge/normalizer patches preserve event-schema cross-references or fail with locations.
- Store materialization publishes with an additive pinned schema migration; destructive change
  holds the candidate and honors drain/force policy.
- Pending/new capability proposals remain inert; baseline conflicts are stripped.
- Stale-base race cannot move `current_version_id`.
- Shadow disagreement rejects a candidate; passing replay can auto-publish only under the safe
  policy above.
- A chat complaint produces an evidence-linked candidate through the same pipeline.
- The optimizer has no executor registration and no runtime tool registry.

## Exit criterion

Given repeated evidence that a browser task is semantically parsing invoices, the optimizer
produces a typed patch that separates retrieval from normalization, adds any needed store schema,
passes deterministic and replay checks, and publishes or holds Graph vN+1 according to policy.
The user sees the complaint/evidence, behavior-level change, risk/capability/migration diffs, and
rollback option—never a node editor.
