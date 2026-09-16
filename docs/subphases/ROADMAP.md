# Roadmap

The active roadmap is [implementation phases](../impl-phases.md). The architecture now has two
internal kinds (`browser`, `decision`), workflow-level MCP control, and no asset/Python runtime.

Immediate work is S8 authoring polish, followed by S9 evidence-driven graph optimization. All
new work must preserve these boundaries:

- browser: page/network capabilities and events; optionally engine-compiled after execution;
- decision: store query/insert/upsert and events;
- users and MCP callers address workflows, not nodes;
- graph/store changes publish together through deterministic gates.
