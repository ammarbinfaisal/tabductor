import { browserSessions, browserProfiles, browserWorkers, workflowBrowserProfiles } from "@tabductor/db";
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
  createBrowserProfile, bindWorkflowProfile, createProfileImport, profileOriginSchema, browserWorkerToken,
} from "@tabductor/engine";
import { z } from "zod";
import { LOCAL_ACCOUNT } from "../auth-context.js";
import { procedure, requireBrowserSessionOwner, requireWorkflowOwner, router } from "../trpc.js";

const sessionInput = z.object({ sessionId: z.string().min(1) });

export const browserSessionRouter = router({
  profiles: procedure.query(async ({ ctx }) => {
    const accountId = ctx.accountId ?? LOCAL_ACCOUNT;
    return ctx.db.select({ id: browserProfiles.id, name: browserProfiles.name, updatedAt: browserProfiles.updatedAt,
      saved: browserProfiles.snapshotGeneration }).from(browserProfiles).where(eq(browserProfiles.accountId, accountId)).orderBy(desc(browserProfiles.createdAt));
  }),
  createProfile: procedure.input(z.object({ name: z.string().trim().min(1).max(120) })).mutation(async ({ ctx, input }) => ({
    profileId: await createBrowserProfile(ctx.db, { accountId: ctx.accountId ?? LOCAL_ACCOUNT, name: input.name }),
  })),
  workflowProfile: procedure.input(z.object({ workflowId: z.string().min(1) })).query(async ({ ctx, input }) => {
    await requireWorkflowOwner(ctx, input.workflowId);
    const [row] = await ctx.db.select({ profileId: workflowBrowserProfiles.profileId }).from(workflowBrowserProfiles).where(eq(workflowBrowserProfiles.workflowId, input.workflowId));
    return row ?? null;
  }),
  bindProfile: procedure.input(z.object({ workflowId: z.string().min(1), profileId: z.string().min(1) })).mutation(({ ctx, input }) =>
    bindWorkflowProfile(ctx.db, { ...input, accountId: ctx.accountId ?? LOCAL_ACCOUNT })),
  importCode: procedure.input(z.object({ profileId: z.string().min(1), origin: profileOriginSchema })).mutation(({ ctx, input }) =>
    createProfileImport(ctx.db, { ...input, accountId: ctx.accountId ?? LOCAL_ACCOUNT })),
  openProfile: procedure.input(z.object({ profileId: z.string().min(1) })).mutation(async ({ ctx, input }) => ({
    sessionId: await requestBrowserSession(ctx.db, { ...input, accountId: ctx.accountId ?? LOCAL_ACCOUNT }),
  })),
  navigate: procedure.input(sessionInput.extend({ url: z.string().url().max(4096) })).mutation(async ({ ctx, input }) => {
    await requireBrowserSessionOwner(ctx, input.sessionId);
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new AppError("navigation_invalid", "Use an HTTP or HTTPS website address");
    const [row] = await ctx.db.select({ session: browserSessions, worker: browserWorkers }).from(browserSessions)
      .innerJoin(browserWorkers, eq(browserWorkers.id, browserSessions.workerId)).where(eq(browserSessions.id, input.sessionId));
    if (!row?.worker.endpointUrl || !["ready", "running"].includes(row.session.status) || row.session.inputOwner !== "human" || !row.session.takeoverExpiresAt || row.session.takeoverExpiresAt <= new Date())
      throw new AppError("browser_input_revoked", "Take control before navigating");
    const response = await fetch(`${row.worker.endpointUrl}/v1/sessions/${encodeURIComponent(input.sessionId)}/navigate`, {
      method: "POST", headers: { authorization: `Bearer ${browserWorkerToken(process.env.BROWSER_WORKER_TOKEN_KEY ?? "", row.worker.podName)}`, "x-tabductor-rpc-version": "1", "content-type": "application/json" },
      body: JSON.stringify({ generation: row.session.generation, input_generation: row.session.inputOwnerGeneration, url: url.href }), signal: AbortSignal.timeout(35000),
    });
    if (!response.ok) throw new AppError("navigation_failed", "The browser could not open this address. Check the live view before trying again.");
    return { navigated: true };
  }),
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
