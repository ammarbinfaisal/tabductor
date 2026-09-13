import { APPROVAL_STATUSES } from "@tabductor/db";
import {
  GRANT_KEYS,
  addBaselineRule,
  decideApproval,
  grantTask,
  listApprovals,
  listBaselineRules,
  listTaskGrants,
  removeBaselineRule,
  revokeTaskGrant,
} from "@tabductor/policy";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { LOCAL_USER, procedure, router } from "../trpc.js";

const grantKey = z.enum(GRANT_KEYS);
const baselineRule = z.object({
  effect: z.enum(["deny", "require_approval"]),
  grantKey,
  value: z.string().min(1).max(500),
});

/** S7's API contract. U5 can render these procedures without inventing UI-only policy logic. */
export const policyRouter = router({
  taskGrants: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .query(({ ctx, input }) => listTaskGrants(ctx.db, input.taskId)),

  grantTask: procedure
    .input(
      z.object({
        taskId: z.string().min(1),
        grantKey,
        grantValue: z.string().min(1).max(500),
        requiresApproval: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => grantTask(ctx.db, input.taskId, input)),

  revokeTaskGrant: procedure
    .input(z.object({ taskId: z.string().min(1), grantKey, grantValue: z.string().min(1).max(500) }))
    .mutation(({ ctx, input }) => revokeTaskGrant(ctx.db, input.taskId, input.grantKey, input.grantValue)),

  baseline: procedure.query(({ ctx }) => listBaselineRules(ctx.db, LOCAL_USER)),

  addBaseline: procedure
    .input(baselineRule)
    .mutation(async ({ ctx, input }) => ({ id: await addBaselineRule(ctx.db, LOCAL_USER, input) })),

  removeBaseline: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => removeBaselineRule(ctx.db, LOCAL_USER, input.id)),

  approvals: procedure
    .input(z.object({ status: z.enum(APPROVAL_STATUSES).optional() }).optional())
    .query(({ ctx, input }) => listApprovals(ctx.db, input?.status)),

  decideApproval: procedure
    .input(z.object({ approvalId: z.string().min(1), decision: z.enum(["granted", "denied"]) }))
    .mutation(async ({ ctx, input }) => {
      const result = await decideApproval(ctx.db, input.approvalId, input.decision);
      if (result.outcome === "missing") {
        throw new TRPCError({ code: "NOT_FOUND", message: `no approval "${input.approvalId}"` });
      }
      if (result.outcome === "not_pending") {
        throw new TRPCError({ code: "CONFLICT", message: `approval "${input.approvalId}" is not pending` });
      }
      if (result.outcome === "expired") {
        throw new TRPCError({ code: "CONFLICT", message: `approval "${input.approvalId}" has expired` });
      }
      return result.approval!;
    }),
});
