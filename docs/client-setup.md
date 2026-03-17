# Client Setup

This package runs as a standard stdio MCP server.

## Server Command

After building, the MCP entrypoint is:

```bash
node dist/index.js
```

You can also use the package bin:

```bash
mcp-server-browsermcp
```

## Client Expectations

Any MCP client should treat this server as:

- a stdio MCP server
- a browser automation server with explicit `sessionId` routing
- a toolset where `browser_sessions` is the discovery entrypoint
- a server that exposes guide resources for LLM workflow and stale-ref recovery

## Recommended LLM Workflow

1. Call `browser_sessions`.
2. Choose one or more `sessionId` values.
3. Call `browser_session_overview` first when you need a compact page summary.
4. Call `browser_actionables` when you need DOM refs. It returns a grouped actionable ref inventory.
5. Call `browser_describe_ref` when one specific ref needs deeper context.
6. Call `browser_snapshot` only when you need broader page context than the grouped actionable view provides.
7. Use action tools normally and let the MCP return change summaries from its cache.
8. Call `browser_state` or `browser_snapshot` only when you need more detail than the action response already provides.

`sessionId` is stable for a tab across reconnects, and read tools return the current full semantic snapshot rather than a transport delta.

## MCP Resources

LLM clients can also read these built-in resources directly:

- `browsermcp://guides/llm-workflow`
- `browsermcp://guides/stale-ref-recovery`

## Why This Shape Fits Codex and Claude

- no hidden current-tab state
- no implicit session switching
- clear parallelization boundary across sessions
- compact overview and discovery reads plus explicit per-ref elaboration
- structured tool output for session metadata, snapshots, and page-change summaries
