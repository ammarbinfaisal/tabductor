import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { TraceRecorder } from "@tabductor/browser";
import { AppError } from "@tabductor/core";
import type { PolicyGate, TaskCtx } from "@tabductor/policy";
import { zero } from "@tabductor/secrets";
import type { SecretsBrokerHandle } from "@tabductor/secrets";
import type { McpCallOutcome, Metrics } from "@tabductor/telemetry";
import type { McpServerSpec } from "./servers.js";

/**
 * The MCP client (S5c deliverable 2, techical_plan §13): one `Client` per configured server,
 * lazy-connected — nothing spawns/dials until the first `listTools`/`callTool` for that
 * server. Scoped **per run**, not per process: `injectIntoMcpArg(runId, secretName)` is
 * itself run-scoped (`packages/secrets/src/broker.ts`), and a stdio server's credential can
 * only be set once, at spawn — sharing one server connection across unrelated runs would mean
 * either re-spawning per run anyway (no saving) or baking one run's secret into a process that
 * outlives it (a standing decryption capability the broker's TTL was built to prevent). One
 * `McpRunClient` per run, holding at most one live connection per server that run actually
 * calls, is what "lazy" and "per configured server" both cash out to once the broker's own
 * per-run contract is taken seriously.
 *
 * §13's two enforced rules are code here, not prompt text:
 *   1. Every call goes through `PolicyGate.checkMcpCall` before it reaches a server.
 *   2. `callTool` returns raw, structured content — never a string pre-wrapped as trusted.
 * The untrusted-data delimiter itself is `packages/agent`'s job (the registry merge, which
 * reuses the loop's own `untrustedBlock` helper) — this package has no opinion on how a tool
 * result is presented to an LLM, only on how it is fetched, budgeted and traced.
 */

const DEFAULT_MAX_CALLS = 20;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** §16 Threat 16-adjacent, same cap and reasoning as `packages/agent/src/tools.ts`'s
 * `MAX_BODY_CHARS`: an unbounded MCP text result would blow the context window the same way
 * an unbounded network body would. */
const MAX_TEXT_CHARS = 4_000;

export type McpToolInfo = { name: string; description: string; inputSchema: Record<string, unknown> };

export type McpToolResult = { ok: true; value: unknown } | { ok: false; error: string };

export type McpRunClientDeps = {
  gate: PolicyGate;
  taskCtx: TaskCtx;
  runId: string;
  trace: TraceRecorder;
  metrics?: Metrics;
  /** Omit in a rig with no broker wired (e.g. a server that needs no credential) — only
   * servers with a `secret_name` ever reach for this. */
  secrets?: Pick<SecretsBrokerHandle, "injectIntoMcpArg" | "redeemMcpHandle">;
  /** `limits_json.mcp.max_calls`, default 20 (§13). */
  maxCalls?: number;
  /** Per-call timeout, default 60s (§13). */
  callTimeoutMs?: number;
};

export type McpRunClient = {
  listTools(serverLabel: string): Promise<McpToolInfo[]>;
  callTool(serverLabel: string, toolName: string, args: unknown): Promise<McpToolResult>;
  /** Closes every connection this run opened. Idempotent-safe to call even if nothing ever
   * connected — the executor's `finally` calls this unconditionally, matching every other
   * resource this codebase releases (`RunSession.close`, `EndpointLease.release`). */
  close(): Promise<void>;
};

function truncateText(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n… [truncated, showing ${MAX_TEXT_CHARS} of ${text.length} chars]`
    : text;
}

/** Collapses an MCP `callTool` result into something JSON-plain: structured output when the
 * server declared one, a single text block unwrapped (and parsed as JSON if it looks like
 * JSON — most servers, including the testkit fake, answer with a JSON-encoded string), or the
 * raw content array for anything richer (images, multiple blocks). Never touches `isError` —
 * the caller already branched on that before this runs. */
function summarizeContent(raw: { content: unknown[]; structuredContent?: Record<string, unknown> }): unknown {
  if (raw.structuredContent !== undefined) return raw.structuredContent;
  const content = raw.content;
  if (content.length === 1) {
    const block = content[0] as { type: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") {
      const text = truncateText(block.text);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return content;
}

type ContentResult = { content: unknown[]; isError?: boolean; structuredContent?: Record<string, unknown> };

/** `Client.callTool`'s return type also covers task-based execution (`{toolResult}`, no
 * `content`), unconditionally on the type level regardless of which `resultSchema` a caller
 * passes — a plain `"content" in raw` narrows nothing here because that variant's index
 * signature (`[x: string]: unknown`) makes every key "present" as far as TS's `in` operator
 * is concerned. This client never asks for task-based execution, so a real server never
 * actually takes that branch; the check is for the type, not the runtime. */
function hasContent(raw: object): raw is ContentResult {
  return Array.isArray((raw as { content?: unknown }).content);
}

/** Every text block anywhere in the result gets the same truncation `summarizeContent`'s
 * single-block path applies — a multi-block or non-text result should not be able to smuggle
 * an unbounded string past the cap just by not being alone. */
function extractErrorText(raw: { content: unknown[] }): string {
  const texts = raw.content
    .filter((b): b is { type: "text"; text: string } => {
      const block = b as { type?: string; text?: unknown };
      return block.type === "text" && typeof block.text === "string";
    })
    .map((b) => b.text);
  return truncateText(texts.join("\n") || "mcp tool reported an error with no text content");
}

async function buildTransport(spec: McpServerSpec, deps: McpRunClientDeps): Promise<Transport> {
  async function redeemedSecret(): Promise<Buffer> {
    if (!spec.secretName) {
      throw new AppError("mcp_secret_misconfigured", `server "${spec.label}" declares a credential slot but no secret_name`, {
        details: { server: spec.label },
      });
    }
    if (!deps.secrets) {
      throw new AppError("mcp_secret_unavailable", `server "${spec.label}" needs a secret but this run has no broker wired`, {
        details: { server: spec.label },
      });
    }
    const handle = await deps.secrets.injectIntoMcpArg(deps.runId, spec.secretName);
    return deps.secrets.redeemMcpHandle(handle);
  }

  if (spec.config.transport === "stdio") {
    // `getDefaultEnvironment()` is the SDK's own safe-inherited-subset default (PATH, HOME,
    // …) — the config's plain `env` layers on top rather than replacing it, so a server that
    // only needs one extra variable does not silently lose the ones a spawned Node process
    // needs to run at all.
    const env: Record<string, string> = { ...getDefaultEnvironment(), ...spec.config.env };
    if (spec.config.secretEnvVar) {
      const plaintext = await redeemedSecret();
      try {
        env[spec.config.secretEnvVar] = plaintext.toString("utf8");
      } finally {
        // Zeroed the instant its one use (setting this env var for spawn) is over — the
        // broker's own contract for every plaintext buffer it ever hands out.
        zero(plaintext);
      }
    }
    return new StdioClientTransport({
      command: spec.config.command,
      args: spec.config.args,
      env,
      ...(spec.config.cwd ? { cwd: spec.config.cwd } : {}),
    });
  }

  const headers: Record<string, string> = {};
  if (spec.secretName) {
    const plaintext = await redeemedSecret();
    try {
      headers[spec.config.secretHeader] = plaintext.toString("utf8");
    } finally {
      zero(plaintext);
    }
  }
  return new StreamableHTTPClientTransport(new URL(spec.config.url), { requestInit: { headers } });
}

export function createMcpRunClient(servers: McpServerSpec[], deps: McpRunClientDeps): McpRunClient {
  const byLabel = new Map(servers.map((s) => [s.label, s]));
  const clients = new Map<string, Client>();
  const toolCache = new Map<string, McpToolInfo[]>();
  const maxCalls = deps.maxCalls ?? DEFAULT_MAX_CALLS;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  let calls = 0;

  async function connect(spec: McpServerSpec): Promise<Client> {
    const cached = clients.get(spec.label);
    if (cached) return cached;
    const transport = await buildTransport(spec, deps);
    const client = new Client({ name: "tabductor-asset-node", version: "1" }, { capabilities: {} });
    await client.connect(transport);
    clients.set(spec.label, client);
    return client;
  }

  async function ensureTools(spec: McpServerSpec): Promise<McpToolInfo[]> {
    const cached = toolCache.get(spec.label);
    if (cached) return cached;
    const client = await connect(spec);
    const { tools } = await client.listTools();
    const info = tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    toolCache.set(spec.label, info);
    return info;
  }

  return {
    async listTools(serverLabel) {
      const spec = byLabel.get(serverLabel);
      if (!spec) {
        throw new AppError("mcp_server_not_found", `no mcp server "${serverLabel}" configured for this user`, {
          details: { server: serverLabel },
        });
      }
      return ensureTools(spec);
    },

    async callTool(serverLabel, toolName, args) {
      const spec = byLabel.get(serverLabel);
      if (!spec) {
        return { ok: false, error: `no mcp server "${serverLabel}" configured for this user` };
      }
      const toolId = `mcp.${serverLabel}.${toolName}`;

      // 1. Policy, always first (§13: "asset agent → PolicyGate.checkMcpCall → MCP client →
      // server"). A denial is a security signal, not run exhaust — it throws, ending the run,
      // exactly the shape `session.ts`'s own `checkNavigation`/`checkAction` denials use.
      const verdict = await deps.gate.checkMcpCall(deps.taskCtx, toolId);
      deps.metrics?.policyVerdicts.add({ check: "mcp_call", result: verdict.allow ? "allow" : "deny" });
      if (!verdict.allow) {
        await deps.trace.record("policy_denied", { check: "mcp_call", server: serverLabel, tool: toolName, rule: verdict.rule });
        deps.metrics?.mcpCalls.add({ server: serverLabel, outcome: "denied" });
        throw new AppError("action_denied", `mcp call denied by ${verdict.rule}`, {
          details: { action: toolId, rule: verdict.rule },
        });
      }

      // 2. Per-run call budget. A breach ends the run with a typed error (§13's own
      // wording) — it is not a recoverable tool error the agent could paper over by trying
      // again, since trying again is exactly what got it here.
      if (calls >= maxCalls) {
        await deps.trace.record("action", {
          action: "mcp.call",
          server: serverLabel,
          tool: toolName,
          ok: false,
          outcome: "budget_exceeded",
        });
        deps.metrics?.mcpCalls.add({ server: serverLabel, outcome: "budget_exceeded" });
        throw new AppError("mcp_call_budget_exceeded", `run ${deps.runId} exceeded its MCP call budget of ${maxCalls}`, {
          details: { server: serverLabel, tool: toolName, maxCalls },
        });
      }
      calls++;

      // 3. The call itself, under a per-call timeout the SDK enforces natively
      // (`RequestOptions.timeout`) — a timeout is a recoverable tool error (§13 spec: "the
      // agent may retry within budget"), never a thrown exception.
      const started = Date.now();
      let outcome: McpCallOutcome;
      let result: McpToolResult;
      try {
        const client = await connect(spec);
        const raw = await client.callTool(
          { name: toolName, arguments: args as Record<string, unknown> },
          CallToolResultSchema,
          { timeout: callTimeoutMs },
        );
        if (!hasContent(raw)) {
          outcome = "error";
          result = { ok: false, error: `${toolId} returned a task-based result, which this client does not support` };
        } else if (raw.isError) {
          outcome = "error";
          result = { ok: false, error: extractErrorText(raw) };
        } else {
          outcome = "ok";
          result = { ok: true, value: summarizeContent(raw) };
        }
      } catch (err) {
        if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
          outcome = "timeout";
          result = { ok: false, error: `${toolId} timed out after ${callTimeoutMs}ms` };
        } else {
          outcome = "error";
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      const durationSeconds = (Date.now() - started) / 1000;

      // Trace carries the call's args and result (§13, "bodies subject to storage opt-out" —
      // the `action` category's flag, same mechanism S3a's page-action trace entries use).
      // Telemetry never does (§17.2) — `mcpCalls`/`mcpCallDuration` below carry only the
      // server label and outcome.
      await deps.trace.record("action", {
        action: "mcp.call",
        server: serverLabel,
        tool: toolName,
        args,
        ok: result.ok,
        outcome,
        result: result.ok ? result.value : result.error,
        duration_ms: Date.now() - started,
      });
      deps.metrics?.mcpCalls.add({ server: serverLabel, outcome });
      deps.metrics?.mcpCallDuration.record(durationSeconds, { server: serverLabel, outcome });

      return result;
    },

    async close() {
      await Promise.all([...clients.values()].map((c) => c.close().catch(() => undefined)));
      clients.clear();
      toolCache.clear();
    },
  };
}
