import {
  createWorkflow,
  getWorkflow,
  graphSchema,
  listVersionTasks,
  listWorkflows,
  publishVersion,
  readEventSchemas,
  readGraph,
} from "@tabductor/engine";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { LOCAL_USER, procedure, router } from "../trpc.js";

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
});
