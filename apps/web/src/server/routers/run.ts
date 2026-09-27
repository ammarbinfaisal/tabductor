import {
  cancelRun,
  getRun,
  listRuns,
  listTraceEntries,
  PAGE_LIMIT,
  RUN_STATUSES,
} from "@tabductor/engine";
import { TRPCError } from "@trpc/server";
import { isDevMode } from "@tabductor/core";
import { z } from "zod";
import { procedure, requireRunOwner, requireWorkflowOwner, router } from "../trpc.js";
import { LOCAL_ACCOUNT } from "../auth-context.js";
import { sessionsForRuns } from "../session-inspection.js";

export const runRouter = router({
  list: procedure
    .input(
      z.object({
        workflowId: z.string().min(1).optional(),
        versionId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        status: z.enum(RUN_STATUSES).optional(),
        cursor: z.string().nullish(),
        limit: z.number().int().min(PAGE_LIMIT.min).max(PAGE_LIMIT.max).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.workflowId) await requireWorkflowOwner(ctx, input.workflowId);
      const accountId = ctx.accountId ?? LOCAL_ACCOUNT;
      const page = await listRuns(ctx.db, { ...input, accountId });
      const sessions = await sessionsForRuns(ctx.db, accountId, page.items.map(run => run.id));
      return { ...page, items: page.items.map(run => {
        const session = sessions.get(run.id);
        return { ...run, browserSessionId: session?.id ?? null, browserSessionStatus: session?.status ?? null,
                  sessionHref: session?.sessionHref ?? null, sessionStatus: session?.status ?? null };
      }) };
    }),

  get: procedure.input(z.object({ runId: z.string().min(1) })).query(async ({ ctx, input }) => {
    await requireRunOwner(ctx, input.runId);
    const detail = await getRun(ctx.db, input.runId);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: `no run "${input.runId}"` });
    const sessions = await sessionsForRuns(ctx.db, ctx.accountId ?? LOCAL_ACCOUNT, [detail.run.id]);
    const browserSession = sessions.get(detail.run.id) ?? null;
    return { ...detail, browserSession, browserSessionId: browserSession?.id ?? null,
      browserSessionStatus: browserSession?.status ?? null, sessionHref: browserSession?.sessionHref ?? null,
      sessionStatus: browserSession?.status ?? null };
  }),

  /**
   * The run inspector's timeline (U1.5): trace entries in `seq` order, forward-paged. The
   * hard cap matches every other list's `PAGE_LIMIT.max` — zod rejects a client that asks
   * for more, at the boundary, before any query runs.
   */
  trace: procedure
    .input(
      z.object({
        runId: z.string().min(1),
        view: z.literal("tools").optional(),
        cursor: z.string().nullish(),
        limit: z.number().int().min(PAGE_LIMIT.min).max(PAGE_LIMIT.max).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireRunOwner(ctx, input.runId);
      const page = await listTraceEntries(ctx.db, input);
      const devMode = isDevMode();
      // Do not expose previously recorded development parameters outside dev mode.
      if (!devMode) {
        page.items = page.items.map((entry) => {
          const payload = entry.payloadJson as Record<string, unknown>;
          if (payload.action !== "tool.call") return entry;
          const { args: _args, ...metadata } = payload;
          return { ...entry, payloadJson: metadata };
        });
      }
      return { ...page, devMode };
    }),

  /** Legal from `queued|running` only; anything terminal is a conflict, not a silent no-op. */
  cancel: procedure.input(z.object({ runId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    await requireRunOwner(ctx, input.runId);
    const cancelled = await cancelRun(ctx.db, input.runId);
    if (cancelled) return cancelled;

    const existing = await getRun(ctx.db, input.runId);
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: `no run "${input.runId}"` });
    throw new TRPCError({
      code: "CONFLICT",
      message: `run "${input.runId}" is ${existing.run.status} and cannot be cancelled`,
    });
  }),

});
