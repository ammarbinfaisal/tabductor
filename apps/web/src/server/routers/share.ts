import {
  createShare,
  getWorkflow,
  listShares,
  publicGraph,
  revokeShare,
  rotateShare,
} from "@tabductor/engine";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { procedure, requireShareOwner, requireWorkflowOwner, router } from "../trpc.js";

/**
 * The owner's side of sharing (S2d). Creating and rotating are the only operations in the
 * system that return a share token, and they return it exactly once — nothing stores the
 * plaintext, so there is no procedure that could hand it back later.
 */
export const shareRouter = router({
  /**
   * Returns the link *and* a preview of what a viewer will be able to read. The preview is
   * part of the operation rather than a separate call on purpose: "create a public link"
   * should not be answerable without seeing what public means for this graph today.
   */
  create: procedure
    .input(z.object({ workflowId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkflowOwner(ctx, input.workflowId);
      return { share: await createShare(ctx.db, input), preview: await visibilityPreview(ctx, input.workflowId) };
    }),

  rotate: procedure
    .input(z.object({ shareId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireShareOwner(ctx, input.shareId);
      return rotateShare(ctx.db, input);
    }),

  revoke: procedure.input(z.object({ shareId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    await requireShareOwner(ctx, input.shareId);
    await revokeShare(ctx.db, input);
    return { ok: true } as const;
  }),

  /** Prefixes and timestamps. Never a token. */
  list: procedure
    .input(z.object({ workflowId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await requireWorkflowOwner(ctx, input.workflowId);
      return listShares(ctx.db, input);
    }),

  /**
   * What a viewer would see, without creating a link — the diff surface for the moment an
   * author ticks or unticks an event type and republishes.
   */
  preview: procedure
    .input(z.object({ workflowId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await requireWorkflowOwner(ctx, input.workflowId);
      return visibilityPreview(ctx, input.workflowId);
    }),
});

export type VisibilityPreview = {
  publicEvents: Array<{ type: string; fields: string[] }>;
  privateEvents: Array<{ type: string }>;
};

/**
 * Built from the same minimized read model as the public overview, then reduced to output
 * contracts. Internal task identities and topology do not cross this owner-facing API either;
 * `fields` comes from the compiled packet schema, exactly what a viewer can read.
 */
async function visibilityPreview(
  ctx: { db: Parameters<typeof getWorkflow>[0] },
  workflowId: string,
): Promise<VisibilityPreview> {
  const workflow = await getWorkflow(ctx.db, workflowId);
  if (!workflow) throw new TRPCError({ code: "NOT_FOUND", message: `no workflow "${workflowId}"` });
  if (!workflow.currentVersionId) return { publicEvents: [], privateEvents: [] };

  const graph = await publicGraph(ctx.db, { versionId: workflow.currentVersionId });
  return {
    publicEvents: graph.events
      .filter((e) => e.public)
      .map((e) => ({ type: e.type, fields: schemaFields(e.packetSchema) })),
    privateEvents: graph.events
      .filter((e) => !e.public)
      .map((e) => ({ type: e.type })),
  };
}

/** Top-level property names of a JSON Schema object, or none if it declares no shape. */
function schemaFields(schema: Record<string, unknown> | undefined): string[] {
  const properties = schema?.["properties"];
  return typeof properties === "object" && properties !== null && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}
