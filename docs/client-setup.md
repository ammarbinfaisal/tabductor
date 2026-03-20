# Client Setup

This package runs as a standard stdio MCP server.

## Server Command

After building, the MCP entrypoint is:

```bash
node dist/index.js
```

You can also use the package bin:

```bash
mcp-server-tabductor
```

## Client Expectations

Any MCP client should treat this server as:

- a stdio MCP server
- a browser automation server with explicit `sessionId` routing
- a toolset where `tabductor_sessions` is the discovery entrypoint
- a server that exposes guide resources for LLM workflow and stale-ref recovery

## Configuration

Tabductor can read settings from a config file and from environment variables.

Default config file lookup:

- `tabductor.config.json`
- `.tabductor.json`

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

Only `TABDUCTOR_*` variables are supported.

Useful categories:

- `mcp.calls`, `mcp.args`, `mcp.results`, `mcp.errors`
- `daemon.lifecycle`, `daemon.requests`, `daemon.responses`, `daemon.errors`
- `tabductor.requests`, `tabductor.responses`, `tabductor.notifications`, `tabductor.errors`

Defaults:

- `TABDUCTOR_LOG_MODE=errors`
- `TABDUCTOR_LOG_DEST=auto`
- `TABDUCTOR_LOG_REDACT=1`

When `TABDUCTOR_LOG_DEST=auto`, the stdio MCP process logs to `stderr` and the detached daemon logs to `/tmp/tabductor.log` by default.

## Recommended LLM Workflow

1. Call `tabductor_sessions`.
2. Choose one or more `sessionId` values.
3. Call `tabductor_session_overview` first when you need a compact page summary.
4. Call `tabductor_click_text` when the task is simply “click the thing named X”.
5. Call `tabductor_type_text` when the task is simply “type into the field named X”.
6. Call `tabductor_actionables` when you need DOM refs. It returns a bounded grouped actionable inventory and accepts filters for query, roles, viewport, and limits.
7. Call `tabductor_find_text` when you want a recommended actionable ref for a text query without acting yet.
8. Call `tabductor_run_js` when the model needs page-local batching across many targets or records, especially for discover/filter/check/dry-run/apply flows that would otherwise require many separate MCP calls. The snippet can return structured data and stream `console` output through progress notifications when the client supports them.
9. Call `tabductor_describe_ref` when one specific ref needs deeper context.
10. Call `tabductor_snapshot` only when you need broader page context than the grouped actionable view provides.
11. Use action tools normally. When the page version advances, the response already includes `nextDiscovery` and `nextRefs` for the next step.
12. Use `tabductor_navigate` with `waitUntil` when you need explicit navigation observation semantics.
13. Call `tabductor_state` or `tabductor_snapshot` only when you need more detail than the action response already provides.

`sessionId` is stable for a tab across reconnects, `ref` is the primary action handle, and read tools expose `pageVersion` so agents can tell when their refs may need to be refreshed.

## MCP Resources

LLM clients can also read these built-in resources directly:

- `tabductor://guides/llm-workflow`
- `tabductor://guides/stale-ref-recovery`

## Why This Shape Fits Codex and Claude

- no hidden current-tab state
- no implicit session switching
- clear parallelization boundary across sessions
- compact overview and discovery reads plus explicit per-ref elaboration
- structured tool output for session metadata, snapshots, and page-change summaries
