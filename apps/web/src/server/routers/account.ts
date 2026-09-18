import { accountMcpTokens } from "@tabductor/db";
import { AppError, loadConfig } from "@tabductor/core";
import {
  createAccountMcpToken,
  createPaddleCreditPurchase,
  createPaddleTransactionClient,
  getCreditBalance,
  parsePaddleCreditPacks,
} from "@tabductor/engine";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { LOCAL_ACCOUNT } from "../auth-context.js";
import { procedure, router } from "../trpc.js";

const accountIdOf = (accountId: string | undefined) => accountId ?? LOCAL_ACCOUNT;

export const accountRouter = router({
  creditBalance: procedure.query(({ ctx }) => getCreditBalance(ctx.db, accountIdOf(ctx.accountId))),

  createCreditPurchase: procedure.input(z.object({
    operationId: z.string().trim().min(1).max(200),
    priceId: z.string().trim().min(1).max(100),
  })).mutation(async ({ ctx, input }) => {
    const config = loadConfig(process.env);
    if (!config.PADDLE_API_KEY || !config.PADDLE_CREDIT_PACKS_JSON) {
      throw new AppError("paddle_unconfigured", "Paddle billing is not configured");
    }
    const environment = config.PADDLE_ENVIRONMENT
      ?? (config.PADDLE_API_KEY.startsWith("pdl_sdbx_") ? "sandbox" : "live");
    const purchase = await createPaddleCreditPurchase(ctx.db, {
      accountId: accountIdOf(ctx.accountId),
      ...input,
      ...(config.PADDLE_CHECKOUT_URL ? { checkoutUrl: config.PADDLE_CHECKOUT_URL } : {}),
    }, {
      packs: parsePaddleCreditPacks(config.PADDLE_CREDIT_PACKS_JSON),
      client: createPaddleTransactionClient({ apiKey: config.PADDLE_API_KEY, environment }),
    });
    return {
      id: purchase.id,
      status: purchase.status,
      checkoutUrl: purchase.checkoutUrl,
      creditUnits: purchase.creditUnits,
    };
  }),

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
