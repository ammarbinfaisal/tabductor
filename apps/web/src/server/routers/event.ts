import { getEvent, listEvents, PAGE_LIMIT } from "@tabductor/engine";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { procedure, requireEventOwner, requireWorkflowOwner, router } from "../trpc.js";
import { LOCAL_ACCOUNT } from "../auth-context.js";

export const eventRouter = router({
  list: procedure
    .input(
      z.object({
        workflowId: z.string().min(1).optional(),
        versionId: z.string().min(1).optional(),
        type: z.string().min(1).optional(),
        cursor: z.string().nullish(),
        limit: z.number().int().min(PAGE_LIMIT.min).max(PAGE_LIMIT.max).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.workflowId) await requireWorkflowOwner(ctx, input.workflowId);
      return listEvents(ctx.db, { ...input, accountId: ctx.accountId ?? LOCAL_ACCOUNT });
    }),

  /** The event plus its causation chain and the runs it started — the feed's breadcrumb. */
  get: procedure.input(z.object({ eventId: z.string().uuid() })).query(async ({ ctx, input }) => {
    await requireEventOwner(ctx, input.eventId);
    const detail = await getEvent(ctx.db, input.eventId);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: `no event "${input.eventId}"` });
    return detail;
  }),
});
