import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * The testkit fake MCP server (S5c deliverable 4) — deterministic, no external calls, spawned
 * over stdio by `packages/mcp`'s client exactly like a real server would be. Three tools:
 *
 *   - `echo`      — returns its input, unchanged (the basic-call and budget/isolation tests).
 *   - `imageStub` — a fixed base64 PNG (the binary-result path).
 *   - `sleep`     — blocks for `ms` (the timeout test's fixture).
 *
 * A fourth behaviour, not a fourth tool: when the env var `FAKE_MCP_REQUIRE_KEY_ENV` names
 * *another* env var, every tool call first checks that named var is present and non-empty —
 * the credential-hygiene test's fixture (`packages/mcp`'s client sets that named var from the
 * redeemed secret at spawn time; this file never sees the secret's *name*, only whichever env
 * var was chosen to carry it). Responses never include the credential's value, on purpose —
 * the whole point of that test is that the key appears nowhere downstream of this process.
 */

const FIXED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function credentialOk(): boolean {
  const requiredVarName = process.env.FAKE_MCP_REQUIRE_KEY_ENV;
  if (!requiredVarName) return true;
  const value = process.env[requiredVarName];
  return typeof value === "string" && value.length > 0;
}

const MISSING_CREDENTIAL = {
  isError: true,
  content: [{ type: "text" as const, text: "missing required credential" }],
};

const server = new McpServer({ name: "tabductor-fake-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.registerTool(
  "echo",
  { description: "Returns its input, unchanged.", inputSchema: { value: z.unknown() } },
  async ({ value }) => {
    if (!credentialOk()) return MISSING_CREDENTIAL;
    return { content: [{ type: "text", text: JSON.stringify({ echoed: value }) }] };
  },
);

server.registerTool("imageStub", { description: "Returns a fixed 1x1 PNG, base64-encoded." }, async () => {
  if (!credentialOk()) return MISSING_CREDENTIAL;
  return { content: [{ type: "image", data: FIXED_PNG_BASE64, mimeType: "image/png" }] };
});

server.registerTool(
  "sleep",
  {
    description: "Blocks for `ms` milliseconds, then returns — the timeout test's fixture.",
    inputSchema: { ms: z.number().int().nonnegative() },
  },
  async ({ ms }) => {
    if (!credentialOk()) return MISSING_CREDENTIAL;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { content: [{ type: "text", text: `slept ${ms}ms` }] };
  },
);

await server.connect(new StdioServerTransport());
