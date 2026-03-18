# Browser Extension Protocol

This MCP package expects the browser extension to speak a small JSON-RPC-style protocol over WebSocket.

## Connection Model

- One browser tab maps to one logical MCP session, even if the underlying websocket reconnects.
- The MCP server assigns the external `sessionId` and keeps it stable for the same tab across reconnects.
- The extension does not need to know the `sessionId`; it only needs to keep one socket per tab alive.
- The MCP layer serializes commands within a session and allows parallel work across sessions.
- The extension should send a hello notification immediately after connect with tab/page metadata and capability flags.

## Request Envelope

The MCP server sends messages in this shape:

```json
{
  "id": "uuid",
  "type": "browser_click",
  "payload": {
    "element": "Submit button",
    "ref": "e123"
  }
}
```

## Success Response Envelope

```json
{
  "id": "uuid",
  "ok": true,
  "result": null
}
```

## Error Response Envelope

```json
{
  "id": "uuid",
  "ok": false,
  "error": {
    "code": "NO_CONNECTED_TAB",
    "message": "Tab is no longer available"
  }
}
```

## Extension Notifications

The extension should send notifications in this shape:

```json
{
  "event": "browser.session.hello",
  "payload": {
    "page": {
      "url": "https://example.com",
      "title": "Example",
      "tabId": 12,
      "windowId": 3
    },
    "capabilities": {
      "structuredSnapshots": true,
      "versionedSnapshots": true,
      "invalidationEvents": true,
      "partialInvalidation": true
    },
    "snapshotVersion": 1
  }
}
```

## Required Message Types

- `getUrl` -> `string`
- `getTitle` -> `string`
- `browser_snapshot` -> structured snapshot response
- `browser_navigate` -> `{ "acknowledged": true }`
- `browser_go_back` -> `{ "acknowledged": true }`
- `browser_go_forward` -> `{ "acknowledged": true }`
- `browser_click` -> `{ "acknowledged": true }`
- `browser_hover` -> `{ "acknowledged": true }`
- `browser_type` -> `{ "acknowledged": true }`
- `browser_select_option` -> `{ "acknowledged": true }`
- `browser_press_key` -> `{ "acknowledged": true }`
- `browser_wait` -> `{ "acknowledged": true }`
- `browser_get_console_logs` -> console entry array
- `browser_run_js` -> structured result with `success`, `result` or `error`, per-run `logs`, `runId`, and timing fields
- `browser_screenshot` -> `string`
- `browser_describe_ref` -> detailed element context for one `ref`

## Required Notifications

- `browser.session.hello`
- `browser.page.updated`
- `browser.snapshot.updated`
- `browser.console.entry` for per-run JS console streaming

## Snapshot Semantics

- Snapshots are structured, not opaque text.
- Every snapshot includes `version`, `mode`, `generatedAt`, `format`, and `root`.
- `root` is a structured node list with stable `nodeId` and optional user-actionable `ref`.
- `mode` may be `full` or `delta`.
- In Tabductor, `browser_snapshot` is intentionally compact and action-first: it should prioritize actionable refs, minimal context hints, and low token cost.
- The current Tabductor implementation emits `format: "semantic-tree-v1"` and groups actionable refs under semantic sections such as search, form, dialog, or main content.
- The current reference implementation returns full current snapshots to the MCP layer; delta delivery remains a future transport optimization, not an LLM-facing contract.
- When the page changes without an immediate snapshot, the extension should still emit `browser.page.updated` with a version bump and invalidation metadata.

## LLM-Facing Goal

The MCP server hides most cache/version bookkeeping from the LLM:

- models call `browser_snapshot` when they need a fresh full semantic view of the page
- models call `browser_run_js` when they need their own page-local selection, filtering, validation, dry-run, or apply logic over many targets, and collapsing that work into one or two calls is cheaper than many fine-grained tool calls
- models call `browser_describe_ref` for deeper inspection of a single element
- action tools operate on `ref`
- the MCP returns lightweight page-change summaries based on invalidation events and cached snapshots

This is why the extension protocol must be richer than the LLM-facing tool contract.

The exact payload/result shapes are defined in [src/protocol/messages.ts](/Users/ammar/Documents/codes/browsermcp/src/protocol/messages.ts).

## Next Protocol Revision

For real same-session optimistic parallelism, the transport should evolve to:

- stable `nodeId`
- `snapshotVersion`
- `stale_snapshot` and `node_not_found` errors
- high-fidelity delta snapshots and dirty-subtree invalidation
