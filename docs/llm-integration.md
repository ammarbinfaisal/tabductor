# Codex and Claude Integration

This MCP server is intended to be run as a standard stdio MCP server.

## Design Goals

- no hidden "current tab" state in the tool contract
- explicit `sessionId` routing on every action
- stable logical tab sessions across reconnects
- compact orientation reads before full snapshots
- bounded, queryable discovery reads on large pages
- structured results for MCP clients that consume structured tool output
- internal snapshot caching so models do not manage low-level invalidation explicitly
- explicit `pageVersion` on read and write responses
- proactive post-action `nextDiscovery` bundles when the page version advances

## Recommended Tool Usage Pattern

1. Call `tabductor_sessions`.
2. Choose one or more `sessionId` values.
3. Call `tabductor_session_overview` when the model first needs to understand page shape and likely interaction zones.
4. Call `tabductor_actionables` on the sessions where DOM refs are needed. Treat it as the default grouped discovery step, and filter it before raising limits.
5. Call `tabductor_find_text` when the model knows the text it wants and needs a `recommendedRef` for the next action.
6. Use `tabductor_run_js` when the model needs page-local batching across many targets: custom selection, filtering, validation, dry-run planning, and optional execution in one or two calls instead of many small MCP actions. Return a JSON-serializable value and use `console.log` for streamed debug output.
7. Use `tabductor_click`, `tabductor_type`, `tabductor_select_option`, and other actions with explicit `sessionId`. Treat `ref` as the primary handle; `element` is optional metadata.
8. Call `tabductor_describe_ref` only for the specific refs that need more context.
9. Call `tabductor_snapshot` only when the model needs broader page context than the overview or filtered actionable grouping provides.
10. Prefer the action response first. When `pageVersion` changes, it already includes `nextDiscovery` and `nextRefs` for the next step.
11. Use `tabductor_navigate` with `waitUntil` when navigation timing matters.
12. Read `tabductor_state` only when you want lightweight metadata or change summaries without another discovery read.

## Discoverable MCP Resources

The server also exposes guide resources that clients can read directly:

- `tabductor://guides/llm-workflow`
- `tabductor://guides/stale-ref-recovery`

## Why This Works Better For LLM Clients

- Codex and Claude do better with explicit routing than with hidden mutable session state.
- Parallel tab work becomes straightforward because requests can be scoped by `sessionId`.
- A compact overview tool is cheaper than starting every task with a full semantic snapshot.
- `pageVersion` is easier for agents to reason about than exposing raw snapshot bookkeeping.
- Compact discovery snapshots are cheaper for models than full-page tree dumps.
- Filterable actionable reads prevent huge pages from blowing out token budgets.
- Per-ref elaboration keeps detail on demand instead of pushing every attribute into every snapshot.
- Structured tool results make it easier for clients to read session metadata and page-change summaries without scraping prose.
- Reconnects do not force the model to rediscover a replacement `sessionId` for the same tab.

## Current Limitation

Within a single session, operations are serialized for safety. True same-session optimistic parallelism still requires:

- stable `nodeId`
- richer transport-level version deltas
- some stale-ref cases still exist when external page changes invalidate refs between turns
- high-fidelity delta snapshots or subtree invalidation
