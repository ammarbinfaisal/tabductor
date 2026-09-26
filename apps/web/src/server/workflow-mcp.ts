import type {
  WorkflowControl,
  WorkflowPublishInput,
  WorkflowScheduleInput,
  WorkflowTriggerInput,
  WorkflowUpdateInput,
} from "@tabductor/mcp";
import { createCaller, type Context } from "./router.js";
import { setWorkflowSchedule, triggerWorkflow, workflowStatus } from "./workflow-control.js";

function publicResult(workflowId: string, versionId: string, extra: Record<string, unknown> = {}) {
  return { workflowId, versionId, ...extra };
}

async function compileAndPublish(ctx: Context, workflowId: string, prompt: string, expectedVersionId: string | null, resultSchema?: Record<string, unknown> | boolean) {
  const caller = createCaller(ctx);
  const compiled = await caller.workflow.compileIntent({ workflowId, intent: prompt, resultSchema: resultSchema ?? null });
  if (!compiled.ok) throw new Error(`workflow compilation failed: ${compiled.error}`);
  const published = await caller.workflow.publishVersion({
    workflowId,
    expectedVersionId,
    graph: compiled.artifact.graph,
    authoring: {
      report: compiled.report,
      proposedGrants: [],
      ...(compiled.artifact.store ? { store: compiled.artifact.store } : {}),
    },
  });
  return publicResult(workflowId, published.versionId, {
    checks: compiled.report.checks,
    pendingApprovals: 0,
  });
}

async function currentVersion(ctx: Context, workflowId: string): Promise<string | null> {
  const caller = createCaller(ctx);
  const current = await caller.workflow.get({ id: workflowId });
  return current.versionId;
}

/** Adapts the existing compiler/publication APIs to workflow-level MCP operations. */
export function createWorkflowControl(ctx: Context): WorkflowControl {
  return {
    status: (input) => workflowStatus(ctx, input),
    async publish(input: WorkflowPublishInput) {
      const caller = createCaller(ctx);
      return caller.workflow.createFromPrompt(input);
    },

    async update(input: WorkflowUpdateInput) {
      const versionId = await currentVersion(ctx, input.workflowId);
      return compileAndPublish(ctx, input.workflowId, input.prompt, versionId, input.resultSchema);
    },

    async trigger(input: WorkflowTriggerInput) {
      return triggerWorkflow(ctx, {
        workflowId: input.workflowId,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.inputs ? { inputs: input.inputs } : {}),
      });
    },

    async schedule(input: WorkflowScheduleInput) {
      const schedule = {
        cron: input.cron,
        timezone: input.timezone ?? "UTC",
        enabled: input.enabled ?? true,
      };
      const published = await setWorkflowSchedule(ctx, {
        workflowId: input.workflowId,
        schedule,
      });
      return publicResult(input.workflowId, published.versionId, schedule);
    },
  };
}
