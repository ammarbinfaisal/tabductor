import {
  buildAssetToolRegistry as buildAssetsOnlyRegistry,
  buildRenderTool,
  type AssetTool,
  type AssetToolDeps,
  type RenderClient,
} from "@tabductor/assets";
import type { McpRunClient, McpToolInfo } from "@tabductor/mcp";
import { z } from "zod";
import { buildPythonTool, type PythonToolDeps } from "./python-tool.js";
import { doneTool, emitTool, failTool, untrustedBlock, type AgentTool, type EmitFn, type ToolResult } from "./tools.js";

/**
 * The asset node's tool registry (S5c, techical_plan §4/§13) — the mirror of `tools.ts`'s
 * browser registry, and the §4 security boundary made code: `mcp.*` and `assets.*` live here
 * and nowhere near the browser registry; `page.*`/`network.*`/`secrets.*` do not exist in this
 * file at all — no import of `@tabductor/browser`'s session type, no name, nothing a future
 * merge could accidentally wire back in without editing this file. `mcp-registry-isolation
 * .test.ts` is the proof this boundary holds, not this comment.
 *
 * `emitTool`/`doneTool`/`failTool` are shared with the browser registry (`tools.ts`) — neither
 * ever touched a page. `assets.*` comes from `@tabductor/assets`, imported read-only per S5c's
 * territory rule; its `AssetTool` shape is structurally identical to this package's `AgentTool`
 * (deliberately, per that package's own doc comment) so wrapping one as the other is a field
 * copy, not a translation.
 */

function assetToolToAgentTool(t: AssetTool): AgentTool {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    async execute(args): Promise<ToolResult> {
      return t.execute(args);
    },
  };
}

/**
 * A best-effort JSON-Schema → zod bridge, not a general implementation. It exists because an
 * MCP server declares its tool inputs as JSON Schema (the wire format the spec mandates) while
 * this codebase's `AgentTool.parameters` is zod everywhere else (S4a's own choice, restated by
 * every registry since) — introducing a JSON-Schema-native path through `llm.ts`/`llm-live.ts`
 * for this one case would mean a second schema representation crossing the whole tool-calling
 * stack for a single caller. Handles what real tool schemas overwhelmingly are — an object of
 * named properties, each a string/number/boolean/array/nested object, optionally required —
 * and falls back to `z.unknown()` for anything it does not recognise (oneOf, enum, $ref, …)
 * rather than guessing wrong. The *local* validation this buys is a courtesy (a bad call fails
 * fast as a tool error instead of a round trip to the server); the server validates for real.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const type = schema.type;
  if (type === "string") return z.string();
  if (type === "number" || type === "integer") return z.number();
  if (type === "boolean") return z.boolean();
  if (type === "array") {
    const items = schema.items;
    const itemSchema = items && typeof items === "object" ? jsonSchemaToZod(items as Record<string, unknown>) : z.unknown();
    return z.array(itemSchema);
  }
  if (type === "object" || schema.properties) {
    const properties = schema.properties;
    if (!properties || typeof properties !== "object") return z.record(z.string(), z.unknown());
    const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]) : []);
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      const propSchema = value && typeof value === "object" ? jsonSchemaToZod(value as Record<string, unknown>) : z.unknown();
      shape[key] = required.has(key) ? propSchema : propSchema.optional();
    }
    return z.object(shape).passthrough();
  }
  return z.unknown();
}

function mcpTool(server: string, info: McpToolInfo, mcp: McpRunClient): AgentTool {
  const name = `mcp.${server}.${info.name}`;
  const parameters = jsonSchemaToZod(info.inputSchema);
  return {
    name,
    description: info.description || `MCP tool "${info.name}" on server "${server}".`,
    parameters,
    async execute(args): Promise<ToolResult> {
      const parsed = parameters.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: `invalid arguments for "${name}": ${parsed.error.message}` };
      }
      // §13's rule 1, in code: an MCP result is untrusted data the instant it re-enters
      // context, wrapped with the identical delimiter `tools.ts`/`loop.ts` use for page and
      // network content — one helper, every untrusted source, never a second convention to
      // remember. §13's rule 2 ("a result cannot confer authority") holds *structurally*
      // here: there is no `page.goto`/`page.upload` tool on this registry for a returned URL
      // to feed, and no host-filesystem-reading tool for a returned path to feed either — the
      // TODO(S5d) below is the one seam that changes once the asset namespace exists to
      // resolve a path *against*, and even then it stays scoped to that namespace, never the
      // host filesystem.
      const result = await mcp.callTool(server, info.name, parsed.data);
      if (!result.ok) return result;
      return { ok: true, value: untrustedBlock(name, result.value) };
    },
  };
}

/** `assets.render` (S5e) came back `{ok:false, kind:"unavailable"}` before any renderer call
 * could exist — the same "not configured" shape `render-client.ts`'s own client returns for a
 * real one that is merely unreachable, so a caller that never wired a renderer sees the
 * ordinary "assets.render failed" tool-error path rather than a construction-time throw. Every
 * rig that never calls `assets.render` (S5c's own suite) needs no changes for this tool's
 * mere *presence* on the registry — only S5f's rig, which actually calls it, supplies `render`. */
const RENDERER_NOT_CONFIGURED: RenderClient = {
  render: async () => ({ ok: false, kind: "unavailable", log: "no renderer configured for this run" }),
};

export type AssetToolRegistryDeps = {
  emit: EmitFn;
  /** `@tabductor/assets`'s own deps — `db`, `blobs`, `userId`, `taskId`, `runId`, `metrics?`. */
  assets: AssetToolDeps;
  /**
   * S5f wiring: `assets.render`'s HTTP client to `apps/renderer` (S5e). Optional because most
   * of this registry's existing callers never render anything — omitting it still puts
   * `assets.render` on the list (this file always adds it now), it just fails closed with
   * `RENDERER_NOT_CONFIGURED` if a task ever calls it without one wired.
   */
  render?: RenderClient;
  mcp: McpRunClient;
  /**
   * Every `mcp.<server>.<tool>` this run may call, resolved once before the loop starts
   * (`listTools` per configured server) rather than lazily per turn — the system prompt needs
   * the full tool list up front the same way the browser registry's does. Pre-Phase-7 this is
   * "every tool on every server this user has configured" (`AllowAllGate`'s posture
   * everywhere else pre-S7, mirroring `assetWriteGrants`' "no rows = open" default); S7 is
   * where a real per-task grant narrows it, without this type changing shape.
   */
  grantedMcpTools: Array<{ server: string; tool: McpToolInfo }>;
  /**
   * `python.run`'s compute client and per-task wall-clock cap. Optional the same way
   * `render` is: the tool is *always* on the registry (an asset node can compute, full
   * stop), and without a client it fails closed with "not configured" as a tool result.
   */
  python?: Omit<PythonToolDeps, "assets"> | undefined;
};

export function buildAssetToolRegistry(deps: AssetToolRegistryDeps): AgentTool[] {
  const assetTools = buildAssetsOnlyRegistry(deps.assets).map(assetToolToAgentTool);
  // S5f deliverable 2: the one place this subphase touches the asset registry.
  // `buildAssetToolRegistry` (S5c) omitted `assets.render` because it did not exist yet
  // (S5e landed after); it exists now, so it belongs on the list the asset node's loop
  // actually gets, the same way `assets.write`/`assets.append`/`assets.read`/`assets.list` do.
  const renderTool = assetToolToAgentTool(buildRenderTool({ ...deps.assets, render: deps.render ?? RENDERER_NOT_CONFIGURED }));
  const mcpTools = deps.grantedMcpTools.map(({ server, tool }) => mcpTool(server, tool, deps.mcp));
  const pythonTool = buildPythonTool({ assets: deps.assets, ...(deps.python ?? {}) });

  return [...assetTools, renderTool, pythonTool, ...mcpTools, emitTool(deps.emit), doneTool(), failTool()];
}
