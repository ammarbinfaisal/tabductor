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
import { router, shareProcedure, shareTokenSchema, type ShareContext } from "../trpc.js";

/**
 * The public read surface (S2d, sharing.md §4).
 *
 * Every procedure here goes through `shareProcedure`, which resolves the token, rate-limits,
 * and puts the read scope on the context as `ctx.view`. Beyond that this file composes and
 * nothing more: the filtering lives in the read models, in SQL, because a private packet
 * that is never selected cannot be leaked by anything written here or above here.
 *
 * The corollary, worth keeping in mind on every edit: **do not call an owner-side read model
 * from this file.** They select prompts, limits, raw ids and `runs.error`.
 */

const page = shareTokenSchema.extend({
  cursor: z.string().max(200).nullish(),
  limit: z.number().int().min(1).max(PUBLIC_PAGE_MAX).optional(),
});
/** An opaque share-scoped id, not a row id — see `refCodec`. */
const ref = z.string().min(1).max(400);

const gone = (): TRPCError => new TRPCError({ code: "NOT_FOUND", message: "no such share" });

/** A ref that does not decode under this share is indistinguishable from one that is unknown. */
function rowId(ctx: ShareContext, value: string): string {
  const id = ctx.view.ref.decode(value);
  if (!id) throw new TRPCError({ code: "NOT_FOUND", message: "not found" });
  return id;
}

export const publicRouter = router({
  /** The graph as a viewer sees it: shape, kinds, schedules, and which events are shared. */
  graph: shareProcedure.input(shareTokenSchema).query(async ({ ctx }) => {
    const workflow = await getWorkflow(ctx.db, ctx.view.workflowId);
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
      publicRunList(ctx.db, { ...ctx.view, cursor: input.cursor, limit: input.limit }),
    ),

  run: shareProcedure.input(shareTokenSchema.extend({ ref })).query(async ({ ctx, input }) => {
    const detail = await publicRunGet(ctx.db, { ...ctx.view, runId: rowId(ctx, input.ref) });
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "no such run" });
    return detail;
  }),

  events: shareProcedure
    .input(page)
    .query(({ ctx, input }) =>
      publicEventList(ctx.db, { ...ctx.view, cursor: input.cursor, limit: input.limit }),
    ),

  /** One event with its causation chain. A private hop keeps its type and drops its packet. */
  event: shareProcedure.input(shareTokenSchema.extend({ ref })).query(async ({ ctx, input }) => {
    const detail = await publicEventGet(ctx.db, { ...ctx.view, eventId: rowId(ctx, input.ref) });
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "no such event" });
    return detail;
  }),
});
