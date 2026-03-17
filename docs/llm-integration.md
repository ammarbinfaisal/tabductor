# Codex and Claude Integration

This MCP server is intended to be run as a standard stdio MCP server.

## Design Goals

- no hidden "current tab" state in the tool contract
- explicit `sessionId` routing on every action
- stable logical tab sessions across reconnects
- compact orientation reads before full snapshots
- structured results for MCP clients that consume structured tool output
- internal snapshot caching so models do not manage versions or invalidation explicitly
- full current snapshots for read tools; versioning is mainly used to reject stale writes

## Recommended Tool Usage Pattern

1. Call `browser_sessions`.
2. Choose one or more `sessionId` values.
3. Call `browser_session_overview` when the model first needs to understand page shape and likely interaction zones.
4. Call `browser_actionables` on the sessions where DOM refs are needed. Treat it as the default grouped discovery step.
5. Use `browser_click`, `browser_type`, `browser_select_option`, and other actions with explicit `sessionId`.
6. Call `browser_describe_ref` only for the specific refs that need more context.
7. Call `browser_snapshot` only when the model needs broader page context than the overview or actionable grouping provides.
8. Read the action response or `browser_state` for lightweight change summaries instead of forcing a new snapshot after every action.

## Discoverable MCP Resources

The server also exposes guide resources that clients can read directly:

- `browsermcp://guides/llm-workflow`
- `browsermcp://guides/stale-ref-recovery`

## Why This Works Better For LLM Clients

- Codex and Claude do better with explicit routing than with hidden mutable session state.
- Parallel tab work becomes straightforward because requests can be scoped by `sessionId`.
- A compact overview tool is cheaper than starting every task with a full semantic snapshot.
- Compact discovery snapshots are cheaper for models than full-page tree dumps.
- Per-ref elaboration keeps detail on demand instead of pushing every attribute into every snapshot.
- Structured tool results make it easier for clients to read session metadata and page-change summaries without scraping prose.
- Reconnects do not force the model to rediscover a replacement `sessionId` for the same tab.

## Current Limitation

Within a single session, operations are serialized for safety. True same-session optimistic parallelism still requires:

- stable `nodeId`
- `snapshotVersion`
- stale-ref errors
- high-fidelity delta snapshots or subtree invalidation
