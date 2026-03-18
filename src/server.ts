import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { Context } from "@/context";
import type { Resource } from "@/resources/resource";
import type { Tool } from "@/tools/tool";
import { logException, logInfo } from "@/utils/log";

type Options = {
  name: string;
  version: string;
  tools: Tool[];
  resources: Resource[];
  context: Context;
};

export async function createServerWithTools(options: Options): Promise<Server> {
  const { name, version, tools, resources, context } = options;
  const server = new Server(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );
  const originalClose = server.close.bind(server);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: tools.map((tool) => tool.schema) };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: resources.map((resource) => resource.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((tool) => tool.schema.name === request.params.name);
    if (!tool) {
      logInfo("mcp.calls", "MCP tool not found", {
        tool: request.params.name,
      });
      return {
        content: [
          { type: "text", text: `Tool "${request.params.name}" not found` },
        ],
        isError: true,
      };
    }

    const startedAt = Date.now();
    logInfo("mcp.calls", "MCP tool call started", {
      tool: request.params.name,
      argumentKeys: Object.keys(request.params.arguments ?? {}),
    });
    if (request.params.arguments) {
      logInfo("mcp.args", "MCP tool arguments", {
        tool: request.params.name,
        arguments: request.params.arguments,
      });
    }

    try {
      const result = await tool.handle(context, request.params.arguments);
      logInfo("mcp.calls", "MCP tool call completed", {
        tool: request.params.name,
        durationMs: Date.now() - startedAt,
        isError: result.isError === true,
        contentItems: result.content.length,
        structuredContentKeys: Object.keys(result.structuredContent ?? {}),
      });
      logInfo("mcp.results", "MCP tool result", {
        tool: request.params.name,
        result,
      });
      return result;
    } catch (error) {
      logException("mcp.errors", "MCP tool call failed", error, {
        tool: request.params.name,
        durationMs: Date.now() - startedAt,
        arguments: request.params.arguments ?? {},
      });
      return {
        content: [{ type: "text", text: String(error) }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resources.find(
      (resource) => resource.schema.uri === request.params.uri,
    );
    if (!resource) {
      return { contents: [] };
    }

    const contents = await resource.read(context, request.params.uri);
    return { contents };
  });

  server.close = async () => {
    await originalClose();
    await context.close();
  };

  return server;
}
