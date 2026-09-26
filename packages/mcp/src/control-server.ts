import { promptInputsSchema } from "@tabductor/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type WorkflowPublishInput = { prompt: string; resultSchema?: Record<string, unknown> | boolean };
export type WorkflowUpdateInput = WorkflowPublishInput & { workflowId: string };
export type WorkflowTriggerInput = { workflowId: string; requestId?: string; inputs?: Record<string, string> };
export type WorkflowScheduleInput = {
  workflowId: string;
  cron: string;
  timezone?: string;
  enabled?: boolean;
};

export interface WorkflowControl {
  status(input: { workflowId: string; executionId: string }): Promise<unknown>;
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

const resultSchemaInput = z.union([z.record(z.unknown()), z.boolean()]).optional()
  .describe("Optional JSON Schema draft-07 for the workflow's final JSON result.");

/** Public automation surface: workflow intent in, published workflow changes out. */
export function createWorkflowMcpServer(control: WorkflowControl): McpServer {
  const server = new McpServer({ name: "tabductor-workflows", version: "1.0.0" });

  server.registerTool("workflow_publish", {
    title: "Publish workflow",
    description: "Create a workflow from one directing prompt and an optional final JSON result schema.",
    inputSchema: { prompt: z.string().trim().min(1).max(20_000), result_schema: resultSchemaInput },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ prompt, result_schema }) => result(await control.publish({ prompt,
    ...(result_schema === undefined ? {} : { resultSchema: result_schema }),
  })));

  server.registerTool("workflow_update", {
    title: "Update workflow",
    description: "Replace the directing workflow prompt and optional result schema, then publish the rebuilt workflow.",
    inputSchema: { workflow_id: z.string().min(1), prompt: z.string().trim().min(1).max(20_000), result_schema: resultSchemaInput },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ workflow_id, prompt, result_schema }) => result(await control.update({ workflowId: workflow_id, prompt,
    ...(result_schema === undefined ? {} : { resultSchema: result_schema }),
  })));

  server.registerTool("workflow_trigger", {
    title: "Run workflow",
    description: "Start the full published workflow from all entry tasks. Individual events cannot be manually triggered.",
    inputSchema: {
      workflow_id: z.string().min(1),
      inputs: promptInputsSchema.optional().describe("Values for $variable-name references, keyed by name without $."),
      request_id: z.string().min(1).max(200).optional().describe("Reuse this request ID when retrying an uncertain response; a new ID starts new work."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ workflow_id, request_id, inputs }) => result(await control.trigger({
    workflowId: workflow_id,
    ...(request_id ? { requestId: request_id } : {}),
    ...(inputs ? { inputs } : {}),
  })));

  server.registerTool("workflow_status", {
    title: "Workflow status and result",
    description: "Poll the executionId returned by workflow_trigger. When finished is true, resultReady indicates whether the final JSON result is available. Failed or cancelled executions include errors.",
    inputSchema: { workflow_id: z.string().min(1), execution_id: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ workflow_id, execution_id }) => result(await control.status({ workflowId: workflow_id, executionId: execution_id })));

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
