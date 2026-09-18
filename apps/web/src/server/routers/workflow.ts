import {
  createWorkflow,
  getWorkflow,
  graphSchema,
  graphDraftArtifactSchema,
  graphStoreArtifactSchema,
  graphCompileReportSchema,
  gateGraphDraft,
  proposedGrantSchema,
  listVersionTasks,
  listWorkflows,
  publishStoreSchema,
  publishVersion,
  readEventSchemas,
  readGraphAuthoring,
  readGraph,
  type GraphGateContext,
} from "@tabductor/engine";
import { accountBaselineRules, secrets, storeSchemas, workflows } from "@tabductor/db";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { LOCAL_USER, procedure, requireWorkflowOwner, router, type Context } from "../trpc.js";
import { LOCAL_ACCOUNT } from "../auth-context.js";
import { setWorkflowSchedule, triggerWorkflow } from "../workflow-control.js";

/** One `StoreTableSpec` (`@tabductor/store`), restated as zod rather than imported: the
 * package's own type is a plain TS shape (it feeds ajv, not a request boundary), and this
 * router is the one place a client-supplied artifact needs a runtime-checked schema.
 * Exported for `store.ts`'s `previewMigration` (U3.5) — one zod declaration for the same
 * wire shape, not two that could drift. */
export const storeTableSpecSchema = z.object({
  primaryKey: z.array(z.string().min(1)).min(1),
  schema: z.record(z.string(), z.unknown()),
});

const compilerBaselineRule = z.object({
  effect: z.enum(["deny", "require_approval"]),
  grantKey: proposedGrantSchema.shape.grantKey,
  value: z.string().min(1),
});

export async function loadGateContext(ctx: Context, workflowId: string): Promise<GraphGateContext> {
  await requireWorkflowOwner(ctx, workflowId);
  const [workflow] = await ctx.db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
  if (!workflow) throw new TRPCError({ code: "NOT_FOUND", message: `no workflow "${workflowId}"` });
  const [latestStore, secretRows, baselineRows] = await Promise.all([
    ctx.db
      .select({ ddl: storeSchemas.ddl })
      .from(storeSchemas)
      .where(eq(storeSchemas.workflowId, workflowId))
      .orderBy(desc(storeSchemas.version))
      .limit(1),
    ctx.db.select({ name: secrets.name }).from(secrets).where(eq(secrets.userId, workflow.userId)),
    ctx.db
      .select({ rule: accountBaselineRules.ruleJson })
      .from(accountBaselineRules)
      .where(eq(accountBaselineRules.userId, workflow.userId)),
  ]);
  const parsedBaseline = baselineRows.map(({ rule }) => compilerBaselineRule.safeParse(rule));
  return {
    ...(ctx.pool ? { pool: ctx.pool } : {}),
    maxHops: workflow.maxHops,
    previousStoreDdl: latestStore[0]?.ddl ?? null,
    secretNames: secretRows.map((row) => row.name),
    baselineRules: parsedBaseline.flatMap((parsed) => parsed.success ? [parsed.data] : []),
    baselineInvalid: parsedBaseline.some((parsed) => !parsed.success),
  };
}

export const workflowRouter = router({
  create: procedure
    .input(z.object({ name: z.string().min(1).max(200), maxHops: z.number().int().positive().max(1000).optional() }))
    .mutation(({ ctx, input }) =>
      createWorkflow(ctx.db, {
        name: input.name,
        userId: LOCAL_USER,
        accountId: ctx.accountId ?? LOCAL_ACCOUNT,
        ...(input.maxHops === undefined ? {} : { maxHops: input.maxHops }),
      }),
    ),

  list: procedure.query(({ ctx }) => listWorkflows(ctx.db, undefined, ctx.accountId ?? LOCAL_ACCOUNT)),

  /** Start the published workflow without exposing its internal entry task ids. */
  trigger: procedure
    .input(
      z.object({
        workflowId: z.string().min(1),
      }).strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWorkflowOwner(ctx, input.workflowId);
      return triggerWorkflow(ctx, input);
    }),

  /** Replace or remove the shared schedule on the workflow's internal entry behavior. */
  setSchedule: procedure
    .input(
      z.object({
        workflowId: z.string().min(1),
        schedule: z
          .object({
            cron: z.string().trim().min(1).max(200),
            timezone: z.string().trim().min(1).max(200),
            enabled: z.boolean(),
          })
          .nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWorkflowOwner(ctx, input.workflowId);
      return setWorkflowSchedule(ctx, input);
    }),

  compileIntent: procedure
    .input(
      z.object({
        workflowId: z.string().min(1),
        intent: z.string().min(1).max(20_000),
        current: graphDraftArtifactSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWorkflowOwner(ctx, input.workflowId);
      if (!ctx.graphCompiler) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "graph compilation unavailable: configure ANTHROPIC_API_KEY or OPENAI_API_KEY",
        });
      }
      let current = input.current;
      if (current && !current.store) {
        const [persisted] = await ctx.db.select().from(storeSchemas)
          .where(eq(storeSchemas.workflowId, input.workflowId)).orderBy(desc(storeSchemas.version)).limit(1);
        if (persisted) current = { ...current, store: graphStoreArtifactSchema.parse({ description: persisted.descriptionText, ddl: persisted.ddl, tablesSpec: persisted.tablesSpecJson }) };
      }
      const compiled = await ctx.graphCompiler.compile({
        intent: input.intent,
        ...(current ? { current } : {}),
        gateContext: await loadGateContext(ctx, input.workflowId),
      });
      return compiled.ok
        ? { ...compiled, artifact: { ...compiled.artifact, proposedGrants: [] } }
        : compiled;
    }),

  /** The workflow, its current graph, and the task ids that graph's nodes resolved to. */
  get: procedure.input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
    await requireWorkflowOwner(ctx, input.id);
    const workflow = await getWorkflow(ctx.db, input.id);
    if (!workflow) throw new TRPCError({ code: "NOT_FOUND", message: `no workflow "${input.id}"` });

    const versionId = workflow.currentVersionId;
    if (!versionId) {
      return {
        workflow,
        versionId: null,
        graph: { tasks: [], events: [] },
        tasks: [],
        eventSchemas: {} as Record<string, Record<string, unknown>>,
        authoring: null,
      };
    }

    return {
      workflow,
      versionId,
      graph: await readGraph(ctx.db, versionId),
      tasks: await listVersionTasks(ctx.db, versionId),
      /** Compiled at publish, displayed read-only — never part of the editable document. */
      eventSchemas: await readEventSchemas(ctx.db, versionId),
      authoring: await readGraphAuthoring(ctx.db, versionId),
    };
  }),

  getCompileReport: procedure
    .input(z.object({ versionId: z.string().min(1) }))
    .query(({ ctx, input }) => readGraphAuthoring(ctx.db, input.versionId)),

  publishVersion: procedure
    .input(
      z.object({
        workflowId: z.string().min(1),
        expectedVersionId: z.string().nullable().optional(),
        graph: graphSchema,
        authoring: z
          .object({
            report: graphCompileReportSchema,
            proposedGrants: z.array(proposedGrantSchema).max(0, "Action grant proposals have been retired").default([]),
            store: graphStoreArtifactSchema.optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWorkflowOwner(ctx, input.workflowId);
      let checked = input;
      if (input.authoring) {
        const gated = await gateGraphDraft(
          {
            graph: input.graph,
            store: input.authoring.store ?? null,
            proposedGrants: input.authoring.proposedGrants,
          },
          await loadGateContext(ctx, input.workflowId),
        );
        checked = {
          ...input,
          graph: gated.artifact.graph,
          authoring: {
            report: {
              checks: [
                ...gated.checks,
                ...input.authoring.report.checks.filter((check) => check.check === "self_repair"),
              ],
              attempts: input.authoring.report.attempts,
            },
            proposedGrants: gated.artifact.proposedGrants,
            ...(gated.artifact.store ? { store: gated.artifact.store } : {}),
          },
        };
      }
      return publishVersion(ctx.db, checked, {
        schemaGenerator: ctx.schemaGenerator,
        ...(ctx.promptCompiler ? { promptCompiler: ctx.promptCompiler } : {}),
        // With a pool, publish also prepares the workflow's store (`PublishDeps.pool`).
        ...(ctx.pool ? { pool: ctx.pool } : {}),
      });
    }),

  /** Lower-level S5g store administration path. Compiled S8 publications carry their store
   * artifact through `publishVersion`; this remains available for direct administration. */
  publishStoreSchema: procedure
    .input(
      z.object({
        workflowId: z.string().min(1),
        description: z.string().max(4000).optional(),
        ddl: z.string().min(1),
        tablesSpec: z.record(z.string(), storeTableSpecSchema),
        confirmDestructive: z.boolean().optional(),
        forceDestructive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWorkflowOwner(ctx, input.workflowId);
      if (!ctx.pool) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "no pool configured for this context" });
      return publishStoreSchema(ctx.db, ctx.pool, input);
    }),
});
