import { promptInputsSchema } from "@tabductor/core";
import { bindWorkflowProfile, createWorkflow, requestWorkflowDeletion, getWorkflow, listWorkflows, publishStoreSchema,
  createPromptWorkflow, saveWorkflowDefinition, readWorkflowDefinition, workflowDefinitionSchema } from "@tabductor/engine";
import { browserSessions, workflowDeletions, workflows, workflowExecutions } from "@tabductor/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { LOCAL_USER, procedure, requireWorkflowOwner, router, type Context } from "../trpc.js";
import { LOCAL_ACCOUNT } from "../auth-context.js";
import { setWorkflowSchedule, triggerWorkflow, workflowStatus } from "../workflow-control.js";

/** One `StoreTableSpec` (`@tabductor/store`), restated as zod rather than imported: the
 * package's own type is a plain TS shape (it feeds ajv, not a request boundary), and this
 * router is the one place a client-supplied artifact needs a runtime-checked schema.
 * Exported for `store.ts`'s `previewMigration` (U3.5) — one zod declaration for the same
 * wire shape, not two that could drift. */
export const storeTableSpecSchema = z.object({
  primaryKey: z.array(z.string().min(1)).min(1),
  schema: z.record(z.string(), z.unknown()),
});

const resultSchemaInput = z.union([z.record(z.unknown()), z.boolean()]).nullable().optional();

export const workflowRouter = router({
  rename: procedure.input(z.object({ workflowId: z.string().min(1), name: z.string().trim().min(1).max(200) }).strict())
    .mutation(async ({ ctx, input }) => {
      await requireWorkflowOwner(ctx, input.workflowId);
      const [workflow] = await ctx.db.update(workflows).set({ name: input.name })
        .where(and(eq(workflows.id, input.workflowId), eq(workflows.accountId, ctx.accountId ?? LOCAL_ACCOUNT), isNull(workflows.deletingAt)))
        .returning({ name: workflows.name });
      if (!workflow) throw new TRPCError({ code: "CONFLICT", message: "This workflow is being deleted." });
      return workflow;
    }),
  delete: procedure.input(z.object({workflowId:z.string().min(1)})).mutation(({ctx,input})=>requestWorkflowDeletion(ctx.db,ctx.accountId??LOCAL_ACCOUNT,input.workflowId)),
  deletionStatus: procedure.input(z.object({workflowId:z.string().min(1)})).query(async ({ctx,input})=>(await ctx.db.select().from(workflowDeletions).where(and(eq(workflowDeletions.workflowId,input.workflowId),eq(workflowDeletions.accountId,ctx.accountId??LOCAL_ACCOUNT))))[0]??null),
  createFromPrompt: procedure.input(z.object({ prompt: workflowDefinitionSchema.shape.prompt, resultSchema: resultSchemaInput, profileId: z.string().min(1).optional() }).strict())
    .mutation(({ ctx, input }) => ctx.db.transaction(async trx => {
      const accountId = ctx.accountId ?? LOCAL_ACCOUNT;
      const created = await createPromptWorkflow(trx, { ...input, userId: LOCAL_USER, accountId });
      if (input.profileId) await bindWorkflowProfile(trx, { accountId, workflowId: created.workflowId, profileId: input.profileId });
      return created;
    })),
  savePrompt: procedure.input(z.object({ workflowId: z.string().min(1), expectedVersionId: z.string().nullable(), definition: workflowDefinitionSchema }).strict())
    .mutation(async ({ ctx, input }) => { await requireWorkflowOwner(ctx, input.workflowId); return saveWorkflowDefinition(ctx.db, input); }),
  progress: procedure.input(z.object({ workflowId: z.string().min(1), versionId: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      await requireWorkflowOwner(ctx, input.workflowId);
      const [workflow, executions] = await Promise.all([
        getWorkflow(ctx.db, input.workflowId),
        ctx.db.select({ id: workflowExecutions.id }).from(workflowExecutions)
          .where(and(eq(workflowExecutions.workflowId, input.workflowId), input.versionId ? eq(workflowExecutions.workflowVersionId, input.versionId) : undefined))
          .orderBy(desc(workflowExecutions.createdAt), desc(workflowExecutions.id)).limit(1),
      ]);
      return { blocked: workflow?.blockedReasonJson ?? null,
        execution: executions[0] ? await workflowStatus(ctx, { workflowId: input.workflowId, executionId: executions[0].id }) : null };
    }),
  status: procedure.input(z.object({ workflowId: z.string().min(1), executionId: z.string().min(1) }))
    .query(({ ctx, input }) => workflowStatus(ctx, input)),
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

  list: procedure.query(async ({ ctx }) => {
    const accountId = ctx.accountId ?? LOCAL_ACCOUNT;
    const [items, sessions] = await Promise.all([
      listWorkflows(ctx.db, undefined, accountId),
      ctx.db.select({ workflowId: workflowExecutions.workflowId, id: browserSessions.id, status: browserSessions.status }).from(browserSessions)
        .innerJoin(workflowExecutions, eq(workflowExecutions.id, browserSessions.executionId))
        .where(eq(browserSessions.accountId, accountId)).orderBy(desc(browserSessions.createdAt)),
    ]);
    return items.map(item => { const session = sessions.find(session => session.workflowId === item.id);
      return { ...item, sessionHref: session ? `/sessions/${encodeURIComponent(session.id)}` : null, sessionStatus: session?.status ?? null }; });
  }),

  /** Start the published workflow without exposing its internal entry task ids. */
  trigger: procedure
    .input(
      z.object({
        workflowId: z.string().min(1),
        requestId: z.string().min(1).max(200).optional(),
        inputs: promptInputsSchema.optional(),
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

  get: procedure.input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
    await requireWorkflowOwner(ctx, input.id);
    const workflow = await getWorkflow(ctx.db, input.id);
    if (!workflow) throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found" });
    const definition = workflow.currentVersionId ? await readWorkflowDefinition(ctx.db, workflow.currentVersionId) : null;
    return { workflow, versionId: workflow.currentVersionId, definition };
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
