import type { Pool } from "pg";
import type { Metrics } from "@tabductor/telemetry";
import { createStoreQueryTool, type StoreTool } from "@tabductor/store";
import { doneTool, emitTool, failTool, type AgentTool, type EmitFn, type ToolResult } from "./tools.js";

/**
 * `kind=decision`'s tool registry (S5g, graph-compilation-llm §2.1/§2.3) — the smallest in
 * the system, deliberately (§8 Threat 9): `store.query` + `emit` + `done`/`fail`, and
 * **nothing else, ever, without a design-doc change** (ROADMAP.md's own words). No import of
 * `@tabductor/browser`, `@tabductor/mcp`, or `@tabductor/assets` appears in this file at all —
 * the same structural guarantee `asset-tools.ts` gives the `mcp.*`/`assets.*` boundary, here
 * for the boundary that has no positive capability on the other side to accidentally admit.
 * `decision-registry-isolation.test.ts` is the proof this holds, not this comment.
 *
 * `emitTool`/`doneTool`/`failTool` come from `tools.ts` exactly as `asset-tools.ts` reuses
 * them — neither ever touched a page, and this file only *reads* that module for three
 * pre-built tools, never adds to it (S5g's territory rule: `tools.ts` is not this subphase's
 * to edit).
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
  metrics?: Metrics;
};

export function buildDecisionToolRegistry(deps: DecisionToolRegistryDeps): AgentTool[] {
  const query = createStoreQueryTool({ pool: deps.pool, workflowId: deps.workflowId, ...(deps.metrics ? { metrics: deps.metrics } : {}) });
  return [storeToolToAgentTool(query), emitTool(deps.emit), doneTool(), failTool()];
}
