import {
  createWorkflow,
  getWorkflow,
  graphSchema,
  listVersionTasks,
  listWorkflows,
  publishStoreSchema,
  publishVersion,
  readEventSchemas,
  readGraph,
} from "@tabductor/engine";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { LOCAL_USER, procedure, router } from "../trpc.js";

/** One `StoreTableSpec` (`@tabductor/store`), restated as zod rather than imported: the
 * package's own type is a plain TS shape (it feeds ajv, not a request boundary), and this
 * router is the one place a client-supplied artifact needs a runtime-checked schema. */
const storeTableSpecSchema = z.object({
  primaryKey: z.array(z.string().min(1)).min(1),
  schema: z.record(z.string(), z.unknown()),
});

export const workflowRouter = router({
  create: procedure
    .input(z.object({ name: z.string().min(1).max(200), maxHops: z.number().int().positive().max(1000).optional() }))
    .mutation(({ ctx, input }) =>
      createWorkflow(ctx.db, {
        name: input.name,
        userId: LOCAL_USER,
        ...(input.maxHops === undefined ? {} : { maxHops: input.maxHops }),
      }),
    ),

  list: procedure.query(({ ctx }) => listWorkflows(ctx.db)),

  /** The workflow, its current graph, and the task ids that graph's nodes resolved to. */
  get: procedure.input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
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
      };
    }

    return {
      workflow,
      versionId,
      graph: await readGraph(ctx.db, versionId),
      tasks: await listVersionTasks(ctx.db, versionId),
      /** Compiled at publish, displayed read-only — never part of the editable document. */
      eventSchemas: await readEventSchemas(ctx.db, versionId),
    };
  }),

  publishVersion: procedure
    .input(z.object({ workflowId: z.string().min(1), graph: graphSchema }))
    .mutation(({ ctx, input }) =>
      publishVersion(ctx.db, input, { schemaGenerator: ctx.schemaGenerator }),
    ),

  /** S5g: the store schema artifact's publish path (graph-compilation-llm §4.2's "the store
   * schema is fixed at save" half) — a separate mutation from `publishVersion` because there
   * is no compiler yet that produces both from one request (this file's own doc comment,
   * `store-schema.ts`). `confirmDestructive` round-trips the diff a rejected destructive call
   * already returned in its `AppError.details.changes`. */
  publishStoreSchema: procedure
    .input(
      z.object({
        workflowId: z.string().min(1),
        description: z.string().max(4000).optional(),
        ddl: z.string().min(1),
        tablesSpec: z.record(z.string(), storeTableSpecSchema),
        confirmDestructive: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      if (!ctx.pool) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "no pool configured for this context" });
      return publishStoreSchema(ctx.db, ctx.pool, input);
    }),
});
