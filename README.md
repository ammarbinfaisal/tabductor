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
git clone https://github.com/ammarbinfaisal/tabductor.git
cd tabductor
bun install
bun run build
```

After the build, the MCP entrypoint is:

```bash
/absolute/path/to/tabductor/dist/index.js
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
      "args": ["/absolute/path/to/tabductor/dist/index.js"]
    }
  }
}
```

If your client has a CLI shortcut, point it at the same `dist/index.js` entrypoint.

#### Codex

```bash
codex mcp add tabductor -- bun /absolute/path/to/tabductor/dist/index.js
```

#### Claude Code

```bash
claude mcp add -s user tabductor -- bun /absolute/path/to/tabductor/dist/index.js
```

#### Gemini CLI

```bash
gemini mcp add -s user -t stdio tabductor bun /absolute/path/to/tabductor/dist/index.js
```

#### Anigravity

Go to **Settings → MCP Servers** and add:

```json
{
  "mcpServers": {
    "tabductor": {
      "command": "bun",
      "args": ["/absolute/path/to/tabductor/dist/index.js"]
    }
  }
}
```

### 4. Optional config file

Tabductor can also read settings from a JSON config file.

Default lookup order:

1. `tabductor.config.json`
2. `.tabductor.json`

You can also point to a specific file with `TABDUCTOR_CONFIG`.

Example:

```json
{
  "host": "127.0.0.1",
  "wsPort": 8765,
  "controlPort": 8766,
  "log": {
    "mode": "errors",
    "dest": "auto",
    "file": "/tmp/tabductor.log",
    "redact": true,
    "include": ["daemon.lifecycle"],
    "exclude": []
  }
}
```

Settings precedence is:

1. built-in defaults
2. config file
3. environment variables

Preferred environment variables use the `TABDUCTOR_` prefix, for example:

- `TABDUCTOR_HOST`
- `TABDUCTOR_WS_PORT`
- `TABDUCTOR_CONTROL_PORT`
- `TABDUCTOR_LOG_MODE`
- `TABDUCTOR_LOG_DEST`
- `TABDUCTOR_LOG_FILE`

### 5. Use it

Once the agent sees the MCP server and the extension is connected, it can operate on the current browser tab.

The transport is local stdio. The browser bridge is local too. Nothing here requires a hosted browser.

## Why Use It

- Uses your existing browser session
- Works with sites where login state matters
- Keeps execution local
- Gives agents direct page interaction tools without spinning up a separate automation browser

## How Agents Use It

Tabductor is session-oriented.

Each connected browser tab is exposed as a session, and the agent operates against that session explicitly instead of relying on hidden client-side state.

That gives agents a few useful properties:

- They can work across multiple tabs in parallel by using separate sessions.
- They can batch page-local work through the JavaScript execution tool instead of making many tiny round trips.
- They can inspect a compact semantic snapshot of the page before acting, which is usually cheaper than treating the page like a raw DOM dump.

In practice, that means an agent can:

- read one session while clicking in another
- keep long-running work isolated per tab
- use snapshots and refs for most interaction
- use one-step text helpers for straightforward clicks and field entry
- fall back to a JS REPL-style snippet when it needs page-local filtering, validation, or multi-step in-page logic

## Snapshots And Sessions

- A session is the stable handle for one connected tab.
- Snapshots are compact, structured views of the page built for agent use, not full serialized DOM copies.
- Actionable elements get refs, so the agent can read first and then act on the exact element it discovered.
- Page versions and snapshot updates help the agent recover when the page changes underneath it.

This model is what makes multi-step workflows practical without forcing the agent to rediscover the entire page after every action.

## Notes

- The MCP server is a local stdio server.
- The extension talks to the local daemon on `ws://127.0.0.1:8765`.
- Multiple MCP clients can reuse the same local daemon.
- If you reload the extension or change permissions, reconnect the active tab from the popup.

## Room To Improve

There is still room to make the agent experience better:

- richer batching and streaming around the JS execution path
- better cross-session orchestration and scheduling
- smarter incremental snapshot updates on complex apps
- broader browser and client setup coverage
- clearer defaults for agents that want to mix fast snapshot reads with occasional JS-heavy page logic

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
