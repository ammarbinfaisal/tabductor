# Tabductor

This folder contains `Tabductor`, a loadable MV3 extension for the standalone Tabductor protocol.

## What It Implements

- one websocket connection per connected tab
- `tabductor.session.hello` after connect
- `tabductor.page.updated` notifications on navigation and mutations
- `tabductor.snapshot.updated` notifications with structured snapshots
- routing of browser action requests from the MCP server to the page
- popup controls for connect, disconnect, and server URL configuration
- popup view of every connected tab with per-tab disconnect controls

## Load Unpacked

1. Open `chrome://extensions`
2. Enable Developer mode
3. Choose Load unpacked
4. Select this `extension/` directory

## Expected Local Server

By default the extension connects to:

```text
ws://127.0.0.1:8765
```

You can change the URL from the popup.

## Notes

- This is a reference implementation, not a hardened production extension.
- Screenshots use `chrome.tabs.captureVisibleTab`, which may briefly activate the target tab if it is not already visible.
- The popup shows all connected tabs so users can disconnect stale sessions without switching tabs first.
- Snapshots are intentionally compact and action-first; use `tabductor_describe_ref` from the MCP side when a single ref needs more detail.
- `tabductor_run_js` and `tabductor_run_js` execute through the Tabductor background worker so page CSP does not block snippet execution.
