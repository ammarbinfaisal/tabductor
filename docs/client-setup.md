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

## Configuration

Tabductor can read settings from a config file and from environment variables.

Default config file lookup:

- `tabductor.config.json`
- `.tabductor.json`
- `browsermcp.config.json`
- `.browsermcp.json`

You can also point to a specific file with `TABDUCTOR_CONFIG`.

Environment variables override config-file values.

Preferred environment variables:

- `TABDUCTOR_HOST`
- `TABDUCTOR_WS_PORT`
- `TABDUCTOR_CONTROL_PORT`
- `TABDUCTOR_LOG_MODE=off|errors|normal|debug|full`
- `TABDUCTOR_LOG_INCLUDE=category1,category2`
- `TABDUCTOR_LOG_EXCLUDE=category1,category2`
- `TABDUCTOR_LOG_DEST=auto|stderr|file`
- `TABDUCTOR_LOG_FILE=/tmp/tabductor.log`
- `TABDUCTOR_LOG_FORMAT=text|json`
- `TABDUCTOR_LOG_REDACT=1|0`
- `TABDUCTOR_DEBUG=1`
- `TABDUCTOR_DEBUG_FULL=1`

Legacy `BROWSERMCP_*` variables are still accepted.

Useful categories:

- `mcp.calls`, `mcp.args`, `mcp.results`, `mcp.errors`
- `daemon.lifecycle`, `daemon.requests`, `daemon.responses`, `daemon.errors`
- `browser.requests`, `browser.responses`, `browser.notifications`, `browser.errors`

Defaults:

- `TABDUCTOR_LOG_MODE=errors`
- `TABDUCTOR_LOG_DEST=auto`
- `TABDUCTOR_LOG_REDACT=1`

When `TABDUCTOR_LOG_DEST=auto`, the stdio MCP process logs to `stderr` and the detached daemon logs to `/tmp/tabductor.log` by default.

## Recommended LLM Workflow

1. Call `browser_sessions`.
2. Choose one or more `sessionId` values.
3. Call `browser_session_overview` first when you need a compact page summary.
4. Call `browser_actionables` when you need DOM refs. It returns a bounded grouped actionable inventory and accepts filters for query, roles, viewport, and limits.
5. Call `browser_find_text` when you want a recommended actionable ref for a text query.
6. Call `browser_run_js` when the model needs page-local batching across many targets or records, especially for discover/filter/check/dry-run/apply flows that would otherwise require many separate MCP calls. The snippet can return structured data and stream `console` output through progress notifications when the client supports them.
7. Call `browser_describe_ref` when one specific ref needs deeper context.
8. Call `browser_snapshot` only when you need broader page context than the grouped actionable view provides.
9. Use action tools normally. When the page version advances, the response already includes `nextDiscovery` and `nextRefs` for the next step.
10. Use `browser_navigate` with `waitUntil` when you need explicit navigation observation semantics.
11. Call `browser_state` or `browser_snapshot` only when you need more detail than the action response already provides.

`sessionId` is stable for a tab across reconnects, `ref` is the primary action handle, and read tools expose `pageVersion` so agents can tell when their refs may need to be refreshed.

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
