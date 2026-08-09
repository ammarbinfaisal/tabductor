import { getTask, updateTask } from "@tabductor/engine";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { procedure, router } from "../trpc.js";

export const taskRouter = router({
  get: procedure.input(z.object({ taskId: z.string().min(1) })).query(async ({ ctx, input }) => {
    const task = await getTask(ctx.db, input.taskId);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: `no task "${input.taskId}"` });
    return task;
  }),

  /**
   * Node knobs, not graph shape (see `updateTask`): `limits` carries the run timeout, the
   * retry policy and the StubExecutor script, which is the panel U0 puts beside each node.
   */
  update: procedure
    .input(
      z.object({
        taskId: z.string().min(1),
        prompt: z.string().nullable().optional(),
        mode: z.string().min(1).max(50).optional(),
        limits: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await updateTask(ctx.db, input);
      return { ok: true } as const;
    }),
});
