import { browserSessions } from "@tabductor/db";
import { and, eq, desc } from "drizzle-orm";
import { AppError } from "@tabductor/core";
import {
  getBrowserSessionPlayback,
  mintBrowserViewToken,
  ensureWorkflowBrowserProfile,
  requestBrowserSession,
  listBrowserSessionActivity,
  requestBrowserTakeover,
  resumeBrowserAutomation,
  stopBrowserSession,
} from "@tabductor/engine";
import { z } from "zod";
import { LOCAL_ACCOUNT } from "../auth-context.js";
import { procedure, requireBrowserSessionOwner, requireWorkflowOwner, router } from "../trpc.js";

const sessionInput = z.object({ sessionId: z.string().min(1) });

export const browserSessionRouter = router({
  list: procedure.query(({ ctx }) => ctx.db.select({ id: browserSessions.id, status: browserSessions.status, profileId: browserSessions.profileId, createdAt: browserSessions.createdAt, inputOwner: browserSessions.inputOwner })
    .from(browserSessions).where(eq(browserSessions.accountId, ctx.accountId ?? LOCAL_ACCOUNT)).orderBy(desc(browserSessions.createdAt)).limit(100)),
  setupProfile: procedure.input(z.object({ workflowId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    await requireWorkflowOwner(ctx, input.workflowId);
    const accountId = ctx.accountId ?? LOCAL_ACCOUNT;
    const profileId = await ensureWorkflowBrowserProfile(ctx.db, accountId, input.workflowId);
    return { sessionId: await requestBrowserSession(ctx.db, { accountId, profileId }) };
  }),
  viewerToken: procedure.input(sessionInput.extend({ access: z.enum(["view", "control"]).default("view") })).mutation(async ({ ctx, input }) => {
    const accountId = ctx.accountId ?? LOCAL_ACCOUNT;
    const [session] = await ctx.db.select().from(browserSessions).where(and(eq(browserSessions.id, input.sessionId), eq(browserSessions.accountId, accountId)));
    if (!session || !["ready", "running"].includes(session.status)) throw new AppError("browser_session_not_found", "active browser session not found");
    if (input.access === "control" && (session.inputOwner !== "human" || !session.takeoverExpiresAt || session.takeoverExpiresAt.getTime() <= Date.now())) throw new AppError("browser_input_revoked", "wait for takeover acknowledgment before controlling the browser");
    const expiresAt = Date.now() + 120_000;
    return { token: mintBrowserViewToken(process.env.BROWSER_WORKER_TOKEN_KEY ?? "", { accountId, sessionId: session.id, generation: session.generation, inputGeneration: session.inputOwnerGeneration, access: input.access, expiresAt }), expiresAt };
  }),
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
