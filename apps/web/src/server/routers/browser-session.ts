import { browserSessions, browserProfiles, browserWorkers, browserTabLeases, tasks, workflowBrowserProfiles, workflowExecutions, workflows } from "@tabductor/db";
import { and, eq, desc, asc, sql } from "drizzle-orm";
import { AppError } from "@tabductor/core";
import {
  getBrowserSessionPlayback,
  browserControlIsActive,
  mintBrowserViewToken,
  ensureWorkflowBrowserProfile,
  openBrowserProfileSession,
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
const workerTabs = z.object({ tabs: z.array(z.object({
  pageId: z.string(), title: z.string(), url: z.string(), selected: z.boolean(), tabKey: z.string().nullable(),
})) });

export const browserSessionRouter = router({
  tabs: procedure.input(sessionInput).query(async ({ ctx, input }) => {
    await requireBrowserSessionOwner(ctx, input.sessionId);
    const [row] = await ctx.db.select({ session: browserSessions, worker: browserWorkers }).from(browserSessions)
      .innerJoin(browserWorkers, eq(browserWorkers.id, browserSessions.workerId)).where(eq(browserSessions.id, input.sessionId));
    if (!row?.worker.endpointUrl || !["ready", "running"].includes(row.session.status)) return [];
    const [response, leases] = await Promise.all([
      fetch(`${row.worker.endpointUrl}/v1/sessions/${encodeURIComponent(input.sessionId)}/tabs?generation=${row.session.generation}`, {
        headers: { authorization: `Bearer ${browserWorkerToken(process.env.BROWSER_WORKER_TOKEN_KEY ?? "", row.worker.podName)}`, "x-tabductor-rpc-version": "1" },
        signal: AbortSignal.timeout(5000), cache: "no-store",
      }),
      ctx.db.select({ tabKey: browserTabLeases.tabKey, runId: browserTabLeases.runId, taskName: tasks.name }).from(browserTabLeases)
        .leftJoin(tasks, eq(tasks.id, browserTabLeases.taskId)).where(eq(browserTabLeases.sessionId, input.sessionId)),
    ]);
    if (!response.ok) throw new AppError("browser_tabs_unavailable", "Browser tabs are temporarily unavailable");
    return workerTabs.parse(await response.json()).tabs.map(tab => {
      const lease = leases.find(item => item.tabKey === tab.tabKey);
      return { ...tab, runId: lease?.runId ?? null, taskName: lease?.taskName ?? null };
    });
  }),
  selectTab: procedure.input(sessionInput.extend({ pageId: z.string().min(1).max(160) })).mutation(async ({ ctx, input }) => {
    await requireBrowserSessionOwner(ctx, input.sessionId);
    const [row] = await ctx.db.select({ session: browserSessions, worker: browserWorkers }).from(browserSessions)
      .innerJoin(browserWorkers, eq(browserWorkers.id, browserSessions.workerId)).where(eq(browserSessions.id, input.sessionId));
    if (!row?.worker.endpointUrl || !["ready", "running"].includes(row.session.status))
      throw new AppError("browser_session_not_found", "Active browser session not found");
    const response = await fetch(`${row.worker.endpointUrl}/v1/sessions/${encodeURIComponent(input.sessionId)}/tabs/select`, {
      method: "POST", headers: { authorization: `Bearer ${browserWorkerToken(process.env.BROWSER_WORKER_TOKEN_KEY ?? "", row.worker.podName)}`, "x-tabductor-rpc-version": "1", "content-type": "application/json" },
      body: JSON.stringify({ generation: row.session.generation, page_id: input.pageId }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new AppError("browser_tab_unavailable", "This tab is no longer available. Refresh the tab list.");
    return { selected: true };
  }),
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
    sessionId: await openBrowserProfileSession(ctx.db, { ...input, accountId: ctx.accountId ?? LOCAL_ACCOUNT }),
  })),
  navigate: procedure.input(sessionInput.extend({ url: z.string().url().max(4096) })).mutation(async ({ ctx, input }) => {
    await requireBrowserSessionOwner(ctx, input.sessionId);
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new AppError("navigation_invalid", "Use an HTTP or HTTPS website address");
    const [row] = await ctx.db.select({ session: browserSessions, worker: browserWorkers }).from(browserSessions)
      .innerJoin(browserWorkers, eq(browserWorkers.id, browserSessions.workerId)).where(eq(browserSessions.id, input.sessionId));
    if (!row?.worker.endpointUrl || !["ready", "running"].includes(row.session.status) || !browserControlIsActive(row.session))
      throw new AppError("browser_input_revoked", "Take control before navigating");
    const response = await fetch(`${row.worker.endpointUrl}/v1/sessions/${encodeURIComponent(input.sessionId)}/navigate`, {
      method: "POST", headers: { authorization: `Bearer ${browserWorkerToken(process.env.BROWSER_WORKER_TOKEN_KEY ?? "", row.worker.podName)}`, "x-tabductor-rpc-version": "1", "content-type": "application/json" },
      body: JSON.stringify({ generation: row.session.generation, input_generation: row.session.inputOwnerGeneration, url: url.href }), signal: AbortSignal.timeout(35000),
    });
    if (!response.ok) throw new AppError("navigation_failed", "The browser could not open this address. Check the live view before trying again.");
    return { navigated: true };
  }),
  list: procedure.input(z.object({cursor:z.string().max(250).optional(),direction:z.enum(["next","previous"]).default("next"),limit:z.number().int().min(1).max(100).default(25)}).optional())
    .query(async ({ctx,input})=>{
      const limit=input?.limit??25, reverse=input?.direction==="previous";
      const owner=eq(browserSessions.accountId,ctx.accountId??LOCAL_ACCOUNT);
      let boundary;
      if(input?.cursor){
        const [at,id]=input.cursor.split("|");
        if(!at||!id||!Number.isFinite(Date.parse(at)))throw new AppError("cursor_invalid","Invalid session cursor");
        boundary=reverse?sql`(${browserSessions.createdAt},${browserSessions.id}) > (${at}::timestamptz,${id})`
          :sql`(${browserSessions.createdAt},${browserSessions.id}) < (${at}::timestamptz,${id})`;
      }
      const [rows,counts]=await Promise.all([
        ctx.db.select({id:browserSessions.id,status:browserSessions.status,profileId:browserSessions.profileId,createdAt:browserSessions.createdAt,
          cursorAt:sql<string>`to_char(${browserSessions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,inputOwner:browserSessions.inputOwner,
          workflowName:workflows.name,profileName:browserProfiles.name})
          .from(browserSessions)
          .leftJoin(workflowExecutions,eq(workflowExecutions.id,browserSessions.executionId))
          .leftJoin(workflows,eq(workflows.id,workflowExecutions.workflowId))
          .leftJoin(browserProfiles,eq(browserProfiles.id,browserSessions.profileId))
          .where(and(owner,boundary)).orderBy(reverse?asc(browserSessions.createdAt):desc(browserSessions.createdAt),reverse?asc(browserSessions.id):desc(browserSessions.id)).limit(limit+1),
        ctx.db.select({total:sql<number>`count(*)::int`,active:sql<number>`count(*) filter (where status not in ('ended','failed'))::int`}).from(browserSessions).where(owner),
      ]);
      const items=rows.slice(0,limit);if(reverse)items.reverse();
      const key=(row:typeof items[number])=>`${row.cursorAt}|${row.id}`;
      return {items,total:counts[0]!.total,active:counts[0]!.active,
        previousCursor:items.length&&(reverse?rows.length>limit:Boolean(input?.cursor))?key(items[0]!):null,
        nextCursor:items.length&&(reverse?Boolean(input?.cursor):rows.length>limit)?key(items.at(-1)!):null};
    }),
  setupProfile: procedure.input(z.object({ workflowId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    await requireWorkflowOwner(ctx, input.workflowId);
    const accountId = ctx.accountId ?? LOCAL_ACCOUNT;
    const profileId = await ensureWorkflowBrowserProfile(ctx.db, accountId, input.workflowId);
    return { sessionId: await openBrowserProfileSession(ctx.db, { accountId, profileId }) };
  }),
  viewerToken: procedure.input(sessionInput.extend({ access: z.enum(["view", "control"]).default("view") })).mutation(async ({ ctx, input }) => {
    const accountId = ctx.accountId ?? LOCAL_ACCOUNT;
    const [session] = await ctx.db.select().from(browserSessions).where(and(eq(browserSessions.id, input.sessionId), eq(browserSessions.accountId, accountId)));
    if (!session || !["ready", "running"].includes(session.status)) throw new AppError("browser_session_not_found", "active browser session not found");
    if (input.access === "control" && !browserControlIsActive(session)) throw new AppError("browser_input_revoked", "wait for takeover acknowledgment before controlling the browser");
    const expiresAt = Date.now() + 120_000;
    return { token: mintBrowserViewToken(process.env.BROWSER_WORKER_TOKEN_KEY ?? "", { accountId, sessionId: session.id, generation: session.generation, inputGeneration: session.inputOwnerGeneration, access: input.access, expiresAt }), expiresAt, inputGeneration: session.inputOwnerGeneration };
  }),
  paste: procedure.input(sessionInput.extend({ text: z.string().min(1).max(100_000), inputGeneration: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await requireBrowserSessionOwner(ctx, input.sessionId);
    const [row] = await ctx.db.select({ session: browserSessions, worker: browserWorkers }).from(browserSessions)
      .innerJoin(browserWorkers, eq(browserWorkers.id, browserSessions.workerId)).where(eq(browserSessions.id, input.sessionId));
    if (!row?.worker.endpointUrl || !["ready", "running"].includes(row.session.status) ||
        !browserControlIsActive(row.session) || row.session.inputOwnerGeneration !== input.inputGeneration)
      throw new AppError("browser_input_revoked", "Take control before pasting");
    const response = await fetch(`${row.worker.endpointUrl}/v1/sessions/${encodeURIComponent(input.sessionId)}/paste`, {
      method: "POST", headers: { authorization: `Bearer ${browserWorkerToken(process.env.BROWSER_WORKER_TOKEN_KEY ?? "", row.worker.podName)}`, "x-tabductor-rpc-version": "1", "content-type": "application/json" },
      body: JSON.stringify({ generation: row.session.generation, input_generation: input.inputGeneration, text: input.text }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new AppError("paste_failed", response.status === 404 ? "Open a new browser session to enable clipboard paste." : "The browser could not paste. Check that you still have control before trying again.");
    return { pasted: true };
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
