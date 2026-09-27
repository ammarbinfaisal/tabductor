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
      const caller = createCaller(ctx);
      const current = await caller.workflow.get({ id: input.workflowId });
      return caller.workflow.savePrompt({ workflowId: input.workflowId, expectedVersionId: versionId,
        definition: { format: "prompt-v1", limits: current.definition?.limits ?? {}, schedule: current.definition?.schedule ?? null,
          prompt: input.prompt, resultSchema: input.resultSchema ?? null } });
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
