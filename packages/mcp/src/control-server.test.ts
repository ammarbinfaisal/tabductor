import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowMcpServer, type WorkflowControl } from "./control-server.js";

describe("workflow control MCP", () => {
  it("exposes only whole-workflow operations and maps their inputs", async () => {
    const control: WorkflowControl = {
      status: vi.fn(async (input) => ({ status: "succeeded", result: { count: 2 }, input })),
      publish: vi.fn(async (input) => ({ operation: "publish", input })),
      update: vi.fn(async (input) => ({ operation: "update", input })),
      trigger: vi.fn(async (input) => ({ operation: "trigger", input })),
      schedule: vi.fn(async (input) => ({ operation: "schedule", input })),
    };
    const server = createWorkflowMcpServer(control);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "workflow_publish",
        "workflow_schedule",
        "workflow_status",
        "workflow_trigger",
        "workflow_update",
      ]);
      const publishSchema = listed.tools.find((tool) => tool.name === "workflow_publish")!.inputSchema;
      expect(Object.keys(publishSchema.properties!)).toEqual(["prompt", "result_schema"]);
      expect(listed.tools.some((tool) => JSON.stringify(tool.inputSchema).includes("task_id"))).toBe(false);

      await client.callTool({ name: "workflow_publish", arguments: { prompt: "Check portals", result_schema: { type: "object" } } });
      await client.callTool({ name: "workflow_update", arguments: { workflow_id: "wf_1", prompt: "Check portals and escalate failures" } });
      await client.callTool({ name: "workflow_trigger", arguments: { workflow_id: "wf_1" } });
      await client.callTool({ name: "workflow_schedule", arguments: { workflow_id: "wf_1", cron: "0 7 * * *", timezone: "Asia/Kolkata", enabled: true } });

      const status = await client.callTool({ name: "workflow_status", arguments: { workflow_id: "wf_1", execution_id: "exec_1" } });
      expect(control.status).toHaveBeenCalledWith({ workflowId: "wf_1", executionId: "exec_1" });
      expect(status.structuredContent).toMatchObject({ status: "succeeded", result: { count: 2 } });
      expect(control.publish).toHaveBeenCalledWith({ prompt: "Check portals", resultSchema: { type: "object" } });
      expect(control.update).toHaveBeenCalledWith({ workflowId: "wf_1", prompt: "Check portals and escalate failures" });
      expect(control.trigger).toHaveBeenCalledWith({ workflowId: "wf_1" });
      expect(control.schedule).toHaveBeenCalledWith({ workflowId: "wf_1", cron: "0 7 * * *", timezone: "Asia/Kolkata", enabled: true });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
