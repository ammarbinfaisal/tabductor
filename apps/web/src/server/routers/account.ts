import { accountMcpTokens } from "@tabductor/db";
import { createAccountMcpToken, getCreditBalance } from "@tabductor/engine";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { LOCAL_ACCOUNT } from "../auth-context.js";
import { procedure, router } from "../trpc.js";

const accountIdOf = (accountId: string | undefined) => accountId ?? LOCAL_ACCOUNT;

export const accountRouter = router({
  creditBalance: procedure.query(({ ctx }) => getCreditBalance(ctx.db, accountIdOf(ctx.accountId))),

  mcpTokens: procedure.query(({ ctx }) => ctx.db.select({
    id: accountMcpTokens.id,
    prefix: accountMcpTokens.tokenPrefix,
    label: accountMcpTokens.label,
    lastUsedAt: accountMcpTokens.lastUsedAt,
    createdAt: accountMcpTokens.createdAt,
  }).from(accountMcpTokens).where(and(
    eq(accountMcpTokens.accountId, accountIdOf(ctx.accountId)),
    isNull(accountMcpTokens.revokedAt),
  )).orderBy(desc(accountMcpTokens.createdAt))),

  createMcpToken: procedure.input(z.object({ label: z.string().trim().min(1).max(120).optional() }))
    .mutation(({ ctx, input }) => createAccountMcpToken(ctx.db, {
      accountId: accountIdOf(ctx.accountId),
      ...(input.label ? { label: input.label } : {}),
    })),

  revokeMcpToken: procedure.input(z.object({ id: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const [revoked] = await ctx.db.update(accountMcpTokens).set({ revokedAt: sql`now()` }).where(and(
      eq(accountMcpTokens.id, input.id),
      eq(accountMcpTokens.accountId, accountIdOf(ctx.accountId)),
      isNull(accountMcpTokens.revokedAt),
    )).returning({ id: accountMcpTokens.id });
    return { revoked: Boolean(revoked) };
  }),
});
