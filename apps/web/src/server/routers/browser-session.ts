import {
  getBrowserSessionPlayback,
  listBrowserSessionActivity,
  requestBrowserTakeover,
  resumeBrowserAutomation,
  stopBrowserSession,
} from "@tabductor/engine";
import { z } from "zod";
import { LOCAL_ACCOUNT } from "../auth-context.js";
import { procedure, requireBrowserSessionOwner, router } from "../trpc.js";

const sessionInput = z.object({ sessionId: z.string().min(1) });

export const browserSessionRouter = router({
  get: procedure.input(sessionInput).query(async ({ ctx, input }) => {
    await requireBrowserSessionOwner(ctx, input.sessionId);
    return getBrowserSessionPlayback(ctx.db, {
      accountId: ctx.accountId ?? LOCAL_ACCOUNT,
      sessionId: input.sessionId,
    });
  }),

  activity: procedure.input(sessionInput.extend({
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })).query(async ({ ctx, input }) => {
    await requireBrowserSessionOwner(ctx, input.sessionId);
    return listBrowserSessionActivity(ctx.db, {
      accountId: ctx.accountId ?? LOCAL_ACCOUNT,
      ...input,
    });
  }),

  requestTakeover: procedure.input(sessionInput.extend({
    ttlMs: z.number().int().min(30_000).max(30 * 60 * 1_000).optional(),
  })).mutation(async ({ ctx, input }) => {
    await requireBrowserSessionOwner(ctx, input.sessionId);
    return requestBrowserTakeover(ctx.db, {
      accountId: ctx.accountId ?? LOCAL_ACCOUNT,
      ...input,
    });
  }),

  resume: procedure.input(sessionInput).mutation(async ({ ctx, input }) => {
    await requireBrowserSessionOwner(ctx, input.sessionId);
    return resumeBrowserAutomation(ctx.db, {
      accountId: ctx.accountId ?? LOCAL_ACCOUNT,
      sessionId: input.sessionId,
    });
  }),

  stop: procedure.input(sessionInput).mutation(async ({ ctx, input }) => {
    await requireBrowserSessionOwner(ctx, input.sessionId);
    return stopBrowserSession(ctx.db, {
      accountId: ctx.accountId ?? LOCAL_ACCOUNT,
      sessionId: input.sessionId,
    });
  }),
});
