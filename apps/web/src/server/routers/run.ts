import {
  cancelRun,
  getRun,
  listRuns,
  listTraceEntries,
  PAGE_LIMIT,
  RUN_STATUSES,
  triggerTask,
} from "@tabductor/engine";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { procedure, router } from "../trpc.js";

export const runRouter = router({
  list: procedure
    .input(
      z.object({
        workflowId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        status: z.enum(RUN_STATUSES).optional(),
        cursor: z.string().nullish(),
        limit: z.number().int().min(PAGE_LIMIT.min).max(PAGE_LIMIT.max).optional(),
      }),
    )
    .query(({ ctx, input }) => listRuns(ctx.db, input)),

  get: procedure.input(z.object({ runId: z.string().min(1) })).query(async ({ ctx, input }) => {
    const detail = await getRun(ctx.db, input.runId);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: `no run "${input.runId}"` });
    return detail;
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
        cursor: z.string().nullish(),
        limit: z.number().int().min(PAGE_LIMIT.min).max(PAGE_LIMIT.max).optional(),
      }),
    )
    .query(({ ctx, input }) => listTraceEntries(ctx.db, input)),

  /** Legal from `queued|running` only; anything terminal is a conflict, not a silent no-op. */
  cancel: procedure.input(z.object({ runId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const cancelled = await cancelRun(ctx.db, input.runId);
    if (cancelled) return cancelled;

    const existing = await getRun(ctx.db, input.runId);
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: `no run "${input.runId}"` });
    throw new TRPCError({
      code: "CONFLICT",
      message: `run "${input.runId}" is ${existing.run.status} and cannot be cancelled`,
    });
  }),

  /**
   * "Trigger now" (U0). The packet is not validated against the task's declared events on
   * purpose: a manual start is an event *source*, like a schedule fire, not an emit from a
   * node — the same reason `schedule.fired` carries an empty packet nobody declared.
   */
  triggerManual: procedure
    .input(
      z.object({
        taskId: z.string().min(1),
        type: z.string().min(1).max(200).optional(),
        packet: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { event, dispatched } = await triggerTask(ctx.db, input);
      return { eventId: event.eventId, type: event.type, runId: dispatched?.runId ?? null };
    }),
});
