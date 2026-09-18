import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type WorkflowPublishInput = { name: string; intent: string; maxHops?: number };
export type WorkflowUpdateInput = { workflowId: string; intent: string };
export type WorkflowTriggerInput = { workflowId: string; requestId?: string };
export type WorkflowScheduleInput = {
  workflowId: string;
  cron: string;
  timezone?: string;
  enabled?: boolean;
};

export interface WorkflowControl {
  publish(input: WorkflowPublishInput): Promise<unknown>;
  update(input: WorkflowUpdateInput): Promise<unknown>;
  trigger(input: WorkflowTriggerInput): Promise<unknown>;
  schedule(input: WorkflowScheduleInput): Promise<unknown>;
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value && typeof value === "object" ? value as Record<string, unknown> : { value },
  };
}

/** Public automation surface: workflow intent in, published workflow changes out. */
export function createWorkflowMcpServer(control: WorkflowControl): McpServer {
  const server = new McpServer({ name: "tabductor-workflows", version: "1.0.0" });

  server.registerTool("workflow_publish", {
    title: "Publish workflow",
    description: "Create and publish a workflow from a name and natural-language intent.",
    inputSchema: {
      name: z.string().min(1).max(200),
      intent: z.string().min(1).max(20_000),
      max_hops: z.number().int().positive().max(1_000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ name, intent, max_hops }) => result(await control.publish({
    name,
    intent,
    ...(max_hops === undefined ? {} : { maxHops: max_hops }),
  })));

  server.registerTool("workflow_update", {
    title: "Update workflow",
    description: "Compile an intent against the current workflow and publish its next version.",
    inputSchema: {
      workflow_id: z.string().min(1),
      intent: z.string().min(1).max(20_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ workflow_id, intent }) => result(await control.update({ workflowId: workflow_id, intent })));

  server.registerTool("workflow_trigger", {
    title: "Run workflow",
    description: "Start the full published workflow from all entry tasks. Individual events cannot be manually triggered.",
    inputSchema: {
      workflow_id: z.string().min(1),
      request_id: z.string().min(1).max(200).optional().describe("Reuse this request ID when retrying an uncertain response; a new ID starts new work."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ workflow_id, request_id }) => result(await control.trigger({
    workflowId: workflow_id,
    ...(request_id ? { requestId: request_id } : {}),
  })));

  server.registerTool("workflow_schedule", {
    title: "Schedule workflow",
    description: "Publish a cron schedule for a workflow's entry behavior.",
    inputSchema: {
      workflow_id: z.string().min(1),
      cron: z.string().min(1),
      timezone: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ workflow_id, cron, timezone, enabled }) => result(await control.schedule({
    workflowId: workflow_id,
    cron,
    ...(timezone === undefined ? {} : { timezone }),
    ...(enabled === undefined ? {} : { enabled }),
  })));

  return server;
}
