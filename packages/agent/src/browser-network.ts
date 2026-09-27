import { NETWORK_READ_PARTS, type RunSession } from "@tabductor/browser";
import { z } from "zod";
import { defineTool, encodeNetworkRead, type AgentTool } from "./tools.js";

const parameters = z.object({
  action: z.enum(["list", "read"]),
  urlPattern: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  index: z.number().int().nonnegative().optional(),
  parts: z.array(z.enum(NETWORK_READ_PARTS)).min(1).optional(),
}).strict();

/** Inspect requests already captured by this run. */
export function browserNetworkTool(session: RunSession): AgentTool {
  return defineTool({
    name: "browser.network",
    description: "Inspect historical network calls from this browser session. action=list returns stable indexes and request metadata (optional urlPattern substring and limit). action=read requires index and parts, selected from request_body, response_body, request_headers, response_headers. Body text is capped in the tool result.",
    parameters,
    execute: async ({ action, urlPattern, limit, index, parts }) => {
      if (action === "list") {
        if (index !== undefined || parts !== undefined) return { ok: false, error: "browser.network list does not accept index or parts" };
        return { ok: true, value: await session.network.list({ urlPattern, limit }) };
      }
      if (index === undefined || !parts) return { ok: false, error: "browser.network read requires index and parts" };
      if (urlPattern !== undefined || limit !== undefined) return { ok: false, error: "browser.network read does not accept urlPattern or limit" };
      return { ok: true, value: encodeNetworkRead(await session.network.read(index, parts)) };
    },
  });
}
