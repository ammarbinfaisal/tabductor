import type {
  ImageContent,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema7Type } from "zod-to-json-schema";

import type { Context } from "@/context";

export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: JsonSchema7Type;
};

export type ToolResult = {
  content: (ImageContent | TextContent)[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export type ToolCallExtra = {
  signal: AbortSignal;
  _meta?: {
    progressToken?: string | number;
    [key: string]: unknown;
  };
  sendNotification: (notification: {
    method: string;
    params?: Record<string, unknown>;
  }) => Promise<void>;
};

export type Tool = {
  schema: ToolSchema;
  handle: (
    context: Context,
    params?: Record<string, any>,
    extra?: ToolCallExtra,
  ) => Promise<ToolResult>;
};
