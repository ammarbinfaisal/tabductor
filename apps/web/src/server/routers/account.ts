import { configuredKeyWrapper } from "@tabductor/secrets";
import { modelCredentials, modelSelections, modelOperations, creditReservations, paymentPurchases, accountMcpTokens } from "@tabductor/db";
import { AppError, loadConfig } from "@tabductor/core";
import {
  saveModelCredential, setModelSelection, modelSelectionSchema, modelCredentialInputSchema, parseModelRates,
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
  modelSettings: procedure.query(async ({ ctx }) => {
    const accountId = accountIdOf(ctx.accountId);
    const [credentials, selections] = await Promise.all([
      ctx.db.select({ id: modelCredentials.id, provider: modelCredentials.provider, label: modelCredentials.label, baseUrl: modelCredentials.baseUrl, createdAt: modelCredentials.createdAt })
        .from(modelCredentials).where(and(eq(modelCredentials.accountId, accountId), isNull(modelCredentials.revokedAt))),
      ctx.db.select().from(modelSelections).where(eq(modelSelections.accountId, accountId)),
    ]);
    return { credentials, selections, platformModels: parseModelRates(loadConfig().MODEL_RATES_JSON) };
  }),
  saveModelCredential: procedure.input(modelCredentialInputSchema)
    .mutation(({ ctx, input }) => saveModelCredential(ctx.db, configuredKeyWrapper(loadConfig()), { ...input, accountId: accountIdOf(ctx.accountId) })),
  setModel: procedure.input(modelSelectionSchema).mutation(({ ctx, input }) => setModelSelection(ctx.db, accountIdOf(ctx.accountId), input)),
  revokeModelCredential: procedure.input(z.object({ id: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const rows = await ctx.db.update(modelCredentials).set({ revokedAt: sql`now()` }).where(and(eq(modelCredentials.id, input.id), eq(modelCredentials.accountId, accountIdOf(ctx.accountId)), isNull(modelCredentials.revokedAt))).returning({ id: modelCredentials.id });
    return { revoked: rows.length > 0 };
  }),
  billing: procedure.query(async ({ ctx }) => {
    const accountId = accountIdOf(ctx.accountId);
    const config = loadConfig();
    const [balance, purchases, usage, models] = await Promise.all([
      getCreditBalance(ctx.db, accountId),
      ctx.db.select({ id: paymentPurchases.id, creditUnits: paymentPurchases.creditUnits, refundedUnits: paymentPurchases.refundedUnits, status: paymentPurchases.status, createdAt: paymentPurchases.createdAt })
        .from(paymentPurchases).where(eq(paymentPurchases.accountId, accountId)).orderBy(desc(paymentPurchases.createdAt)).limit(50),
      ctx.db.select({ category: creditReservations.category, units: sql<number>`coalesce(sum(${creditReservations.settledUnits}), 0)::double precision` })
        .from(creditReservations).where(and(eq(creditReservations.accountId, accountId), eq(creditReservations.status, "settled"))).groupBy(creditReservations.category),
      ctx.db.select({ id: modelOperations.id, model: modelOperations.model, funding: modelOperations.funding, purpose: modelOperations.purpose, status: modelOperations.status,
        inputTokens: modelOperations.inputTokens, outputTokens: modelOperations.outputTokens, chargedUnits: modelOperations.chargedUnits, createdAt: modelOperations.createdAt })
        .from(modelOperations).where(eq(modelOperations.accountId, accountId)).orderBy(desc(modelOperations.createdAt)).limit(50),
    ]);
    return { balance, purchases, usage, models, packs: config.PADDLE_API_KEY && config.PADDLE_CREDIT_PACKS_JSON ? [...parsePaddleCreditPacks(config.PADDLE_CREDIT_PACKS_JSON).values()] : [] };
  }),
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
