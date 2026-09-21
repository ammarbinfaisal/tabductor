import { recordOutcomeTool } from "./record-tools.js";
import type { Pool } from "pg";
import type { Metrics } from "@tabductor/telemetry";
import {
  createStoreInsertTool,
  createStoreQueryTool,
  createStoreUpsertTool,
  type StoreTool,
  type StoreWriteToolDeps,
} from "@tabductor/store";
import { doneTool, emitTool, failTool, type AgentTool, type EmitFn, type ToolResult } from "./tools.js";

/**
 * `kind=decision`'s tool registry: workflow-store query/insert/upsert plus
 * `emit`/`done`/`fail`. It imports no browser or MCP runtime, so the two-kind boundary is
 * structural rather than prompt-based.
 *
 * `emitTool`/`doneTool`/`failTool` come from `tools.ts`; neither they nor this registry touch a page.
 */

function storeToolToAgentTool(t: StoreTool): AgentTool {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    async execute(args): Promise<ToolResult> {
      return t.execute(args);
    },
  };
}

export type DecisionToolRegistryDeps = {
  pool: Pool;
  workflowId: string;
  emit: EmitFn;
  recordOutcome?: import("@tabductor/engine").RunHandle["recordOutcome"];
  recordCompletionError?: import("@tabductor/engine").RunHandle["recordCompletionError"];
  metrics?: Metrics;
  write: StoreWriteToolDeps;
};

export function buildDecisionToolRegistry(deps: DecisionToolRegistryDeps): AgentTool[] {
  const query = createStoreQueryTool({ pool: deps.pool, workflowId: deps.workflowId, ...(deps.metrics ? { metrics: deps.metrics } : {}) });
  return [
    storeToolToAgentTool(query),
    storeToolToAgentTool(createStoreInsertTool(deps.write)),
    storeToolToAgentTool(createStoreUpsertTool(deps.write)),
    emitTool(deps.emit),
    ...(deps.recordOutcome ? [recordOutcomeTool(deps.recordOutcome)] : []),
    { ...doneTool(), async execute(args, signal) {
      const error = await deps.recordCompletionError?.();
      return error ? { ok: false as const, error } : doneTool().execute(args, signal);
    } },
    failTool(),
  ];
}
