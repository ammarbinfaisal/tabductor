<h3 align="center">Tabductor</h3>

<p align="center">
  Use your real Chrome session from any agent that supports local stdio MCP servers.
</p>

## What It Does

Tabductor connects an MCP client to the Chrome tab you already have open.

That means your agent can:

- read the current page
- find clickable and fillable elements
- click, type, navigate, and wait
- run page-local JavaScript when needed
- work inside your logged-in browser profile instead of a disposable test browser

It is designed for agents that can launch local stdio MCP servers.

## Requirements

- Bun
- Chrome or another Chromium browser that can load unpacked extensions
- An MCP client that supports local stdio servers

## Quick Start

### 1. Clone and build

```bash
git clone https://github.com/ammarbinfaisal/browserctx.git
cd browserctx
bun install
bun run build
```

After the build, the MCP entrypoint is:

```bash
/absolute/path/to/browserctx/dist/index.js
```

Keep that path. Your MCP client will run it over stdio.

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the repo's `extension/` directory
5. Open the `Tabductor` popup
6. Confirm the server URL is `ws://127.0.0.1:8765`
7. Click `Connect Active Tab`

The popup should show:

- `Active Tab Connected: true`
- `Socket Status: open`

### 3. Add the MCP server to your agent

If your agent supports local stdio MCP servers, the generic shape is:

```json
{
  "mcpServers": {
    "tabductor": {
      "command": "bun",
      "args": ["/absolute/path/to/browserctx/dist/index.js"]
    }
  }
}
```

If your client has a CLI shortcut, point it at the same `dist/index.js` entrypoint.

#### Codex

```bash
codex mcp add tabductor-local -- bun /absolute/path/to/browserctx/dist/index.js
```

#### Claude Code

```bash
claude mcp add -s user tabductor-local -- bun /absolute/path/to/browserctx/dist/index.js
```

#### Gemini CLI

```bash
gemini mcp add -s user -t stdio tabductor-local bun /absolute/path/to/browserctx/dist/index.js
```

### 4. Use it

Once the agent sees the MCP server and the extension is connected, it can operate on the current browser tab.

The transport is local stdio. The browser bridge is local too. Nothing here requires a hosted browser.

## Why Use It

- Uses your existing browser session
- Works with sites where login state matters
- Keeps execution local
- Gives agents direct page interaction tools without spinning up a separate automation browser

## Notes

- The MCP server is a local stdio server.
- The extension talks to the local daemon on `ws://127.0.0.1:8765`.
- Multiple MCP clients can reuse the same local daemon.
- If you reload the extension or change permissions, reconnect the active tab from the popup.

## Logging

Logging controls are available through environment variables when you need deeper debugging.

You can also launch the daemon explicitly:

```bash
mcp-server-tabductor daemon
```

## Credits

Tabductor started from earlier browser-control MCP work and has since been reworked around its own extension bridge, daemon, and session-oriented tooling.

The main outside influences were:

- [BrowserMCP](https://github.com/BrowserMCP/mcp)
- [Playwright MCP server](https://github.com/microsoft/playwright-mcp)
