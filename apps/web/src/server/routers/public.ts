import {
  getWorkflow,
  publicEventGet,
  publicEventList,
  publicGraph,
  publicRunGet,
  publicRunList,
  PUBLIC_PAGE_MAX,
} from "@tabductor/engine";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, shareProcedure, type ShareContext } from "../trpc.js";

/**
 * The public read surface (S2d, sharing.md §4).
 *
 * Every procedure here goes through `shareProcedure`, which resolves the token, rate-limits,
 * and puts `{share, ref, publicTypes}` on the context. Beyond that this file composes and
 * nothing more: the filtering lives in the read models, in SQL, because a private packet
 * that is never selected cannot be leaked by anything written here or above here.
 *
 * The corollary, worth keeping in mind on every edit: **do not call an owner-side read model
 * from this file.** They select prompts, limits, raw ids and `runs.error`.
 */

const token = z.object({ token: z.string().min(1).max(200) });
const page = token.extend({
  cursor: z.string().max(200).nullish(),
  limit: z.number().int().min(1).max(PUBLIC_PAGE_MAX).optional(),
});
/** An opaque share-scoped id, not a row id — see `refCodec`. */
const ref = z.string().min(1).max(400);

const gone = (): TRPCError => new TRPCError({ code: "NOT_FOUND", message: "no such share" });

/** A ref that does not decode under this share is indistinguishable from one that is unknown. */
function rowId(ctx: ShareContext, value: string): string {
  const id = ctx.ref.decode(value);
  if (!id) throw new TRPCError({ code: "NOT_FOUND", message: "not found" });
  return id;
}

export const publicRouter = router({
  /** The graph as a viewer sees it: shape, kinds, schedules, and which events are shared. */
  graph: shareProcedure.input(token).query(async ({ ctx }) => {
    const workflow = await getWorkflow(ctx.db, ctx.share.workflowId);
    if (!workflow) throw gone();
    return {
      name: workflow.name,
      graph: workflow.currentVersionId
        ? await publicGraph(ctx.db, { versionId: workflow.currentVersionId })
        : { tasks: [], edges: [] },
    };
  }),

  runs: shareProcedure
    .input(page)
    .query(({ ctx, input }) =>
      publicRunList(ctx.db, {
        workflowId: ctx.share.workflowId,
        ref: ctx.ref,
        cursor: input.cursor,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    ),

  run: shareProcedure.input(token.extend({ ref })).query(async ({ ctx, input }) => {
    const detail = await publicRunGet(ctx.db, {
      workflowId: ctx.share.workflowId,
      ref: ctx.ref,
      publicTypes: ctx.publicTypes,
      runId: rowId(ctx, input.ref),
    });
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "no such run" });
    return detail;
  }),

  events: shareProcedure
    .input(page)
    .query(({ ctx, input }) =>
      publicEventList(ctx.db, {
        workflowId: ctx.share.workflowId,
        ref: ctx.ref,
        publicTypes: ctx.publicTypes,
        cursor: input.cursor,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    ),

  /** One event with its causation chain. A private hop keeps its type and drops its packet. */
  event: shareProcedure.input(token.extend({ ref })).query(async ({ ctx, input }) => {
    const detail = await publicEventGet(ctx.db, {
      workflowId: ctx.share.workflowId,
      ref: ctx.ref,
      publicTypes: ctx.publicTypes,
      eventId: rowId(ctx, input.ref),
    });
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "no such event" });
    return detail;
  }),
});
