# Graph and store compilation

The author supplies workflow intent. An LLM proposes a complete internal `GraphDraftArtifact`;
deterministic code validates it, repairs may retry with the full report, and publication writes
the accepted artifact. The LLM never edits database rows directly.

## Internal kinds

`browser` performs page work and emits structured observations. `decision` performs semantic
work, queries/inserts/upserts the workflow store, and emits structured decisions. Both may be
scheduled or event-triggered. The compiler authors only `mode=ai`; `stub` is test-only and
browser `compiled` is engine-assigned after execution.

The registries are disjoint: browser has page and guarded network tools but no store; decision
has store and lifecycle tools but no browser, files, Python, or third-party MCP.

## Store artifact

When durable normalized state is useful, the compiler includes DDL and a JSON Schema for each
table. Table schemas validate decision writes. The DDL and table specification must be
bijective. Store changes are migration-classified and published in the same candidate as the
graph that relies on them.

## Gate order

1. Parse the typed artifact and validate identities.
2. Enforce two-kind/mode constraints.
3. Validate event declarations and routing.
4. Validate store DDL and table specs, including scratch-schema application.
5. Validate task references to store tables.
6. Classify migration risk and require confirmation when destructive.
7. Strip or flag invalid capability proposals.
8. Check cycles against workflow hop budgets.
9. Report coherence warnings.

Failed checks return to the model as structured repair evidence. Exhausted repair attempts leave
the current published version untouched.

## Control-plane MCP

The MCP endpoint wraps this compiler. Publish creates a workflow then compiles/publishes intent;
update compiles a fresh graph from the replacement prompt and result schema; trigger and
schedule resolve root behaviors internally. The protocol surface never asks callers to construct
or understand the internal graph.
