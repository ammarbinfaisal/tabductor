import type {
  WorkflowControl,
  WorkflowPublishInput,
  WorkflowScheduleInput,
  WorkflowTriggerInput,
  WorkflowUpdateInput,
} from "@tabductor/mcp";
import { graphStoreArtifactSchema, type GraphDraftArtifact } from "@tabductor/engine";
import { storeSchemas } from "@tabductor/db";
import { desc, eq } from "drizzle-orm";
import { createCaller, type Context } from "./router.js";
import { setWorkflowSchedule, triggerWorkflow } from "./workflow-control.js";

function publicResult(workflowId: string, versionId: string, extra: Record<string, unknown> = {}) {
  return { workflowId, versionId, ...extra };
}

async function compileAndPublish(ctx: Context, workflowId: string, intent: string, current?: GraphDraftArtifact, expectedVersionId: string | null = null) {
  const caller = createCaller(ctx);
  const compiled = await caller.workflow.compileIntent({ workflowId, intent, ...(current ? { current } : {}) });
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

async function currentArtifact(ctx: Context, workflowId: string): Promise<{ artifact: GraphDraftArtifact; versionId: string | null }> {
  const caller = createCaller(ctx);
  const current = await caller.workflow.get({ id: workflowId });
  const [store] = await ctx.db
    .select()
    .from(storeSchemas)
    .where(eq(storeSchemas.workflowId, workflowId))
    .orderBy(desc(storeSchemas.version))
    .limit(1);
  return { versionId: current.versionId, artifact: {
    graph: current.graph,
    store: store
      ? graphStoreArtifactSchema.parse({
          description: store.descriptionText,
          ddl: store.ddl,
          tablesSpec: store.tablesSpecJson,
        })
      : null,
    proposedGrants: [],
  } };
}

/** Adapts the existing compiler/publication APIs to workflow-level MCP operations. */
export function createWorkflowControl(ctx: Context): WorkflowControl {
  return {
    async publish(input: WorkflowPublishInput) {
      const caller = createCaller(ctx);
      const workflowId = await caller.workflow.create({
        name: input.name,
        ...(input.maxHops === undefined ? {} : { maxHops: input.maxHops }),
      });
      return compileAndPublish(ctx, workflowId, input.intent);
    },

    async update(input: WorkflowUpdateInput) {
      const current = await currentArtifact(ctx, input.workflowId);
      return compileAndPublish(ctx, input.workflowId, input.intent, current.artifact, current.versionId);
    },

    async trigger(input: WorkflowTriggerInput) {
      return triggerWorkflow(ctx, {
        workflowId: input.workflowId,
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
