# Parallel Sessions Rewrite

This package now exposes a stateless session-oriented MCP API instead of a single implicit connected tab.

## Goals

- Allow LLMs to control multiple connected browser sessions in parallel.
- Keep read semantics stable and current for agents, even when the underlying transport reconnects.
- Keep actions on the same session serialized to avoid DOM races.
- Create a clean base for a future versioned snapshot protocol.
- Hide cache/version bookkeeping from the LLM-facing tools.

## Current API Surface

- `browser_sessions`
- `browser_state`
- `browser_session_overview`
- `browser_snapshot`
- `browser_navigate`
- `browser_click`
- `browser_hover`
- `browser_type`
- `browser_select_option`
- `browser_go_back`
- `browser_go_forward`
- `browser_press_key`
- `browser_wait`
- `browser_console_logs`
- `browser_screenshot`

Most tools require:

- `sessionId`: Explicit target from `browser_sessions`.

The MCP internally manages:

- snapshot caching
- snapshot versions
- invalidation tracking
- page-change summaries after actions
- post-action discovery refreshes when the page version advances

The MCP also exposes guide resources for LLM clients:

- `browsermcp://guides/llm-workflow`
- `browsermcp://guides/stale-ref-recovery`

## Execution Model

- Each browser tab is stored as its own logical browser session.
- Sessions are independent and can run in parallel.
- Operations within a single session are serialized.
- There is no mutable "current session" in the MCP API.
- Session IDs remain stable for the same tab across reconnects.

## What This Phase Does Not Solve

This is not yet true same-tab parallel DOM automation.

The current transport now supports structured/versioned snapshots internally, but same-session optimistic parallelism still depends on the extension fully implementing version-aware errors and invalidation fidelity. In practice:

- refs are still derived from snapshots
- same-session writes are still serialized
- stale-ref handling still depends on extension-side version checks, although the MCP now returns fresh discovery state inline on stale responses
- partial invalidation quality depends on extension notifications
- read tools currently rely on full current snapshots for correctness

Because of that, safe parallel writes should still be treated as cross-session, not same-session.

## Next Protocol Phase

The next phase should move the extension and shared message types to a versioned snapshot model:

- add stable `nodeId`
- add `snapshotVersion`
- add delta snapshots and dirty-subtree invalidation
- return structured `stale_snapshot` errors

At that point the MCP layer can safely support:

- parallel reads against the same snapshot version
- partial invalidation after localized DOM changes
- conflict-aware retries when refs go stale
