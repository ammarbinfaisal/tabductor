import { configuredKeyWrapper } from "@tabductor/secrets";
import { modelCredentials, modelSelections, modelOperations, creditReservations, paymentPurchases, accountMcpTokens, accounts, billingRates } from "@tabductor/db";
import { AppError, loadConfig, usdDecimal } from "@tabductor/core";
import {
  prepareUsdWallet, redeemBalanceCoupon, purchaseDiscount,
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
    const configured=parseModelRates(loadConfig().MODEL_USD_RATES_JSON);
    const prices=await ctx.db.select().from(billingRates).where(eq(billingRates.category,"model")).orderBy(desc(billingRates.createdAt),desc(billingRates.id));
    for(const p of prices.filter(p=>p.item.endsWith(":input"))){const model=p.item.slice(0,-6);if(prices.find(r=>r.provider===p.provider&&r.item===p.item)?.id!==p.id)continue;
      const output=prices.find(r=>r.provider===p.provider&&r.item===`${model}:output`),cached=prices.find(r=>r.provider===p.provider&&r.item===`${model}:cached`);
      if(!output)continue;const index=configured.findIndex(r=>r.provider===p.provider&&r.model===model);
      const entry={provider:p.provider as "openai"|"anthropic",model,version:p.id,input:p.chargeMicros,cachedInput:cached?.chargeMicros??p.chargeMicros,output:output.chargeMicros,maxInputTokens:128000,maxOutputTokens:8192};
      if(index<0)configured.push(entry);else configured[index]=entry;
    }
    return { credentials, selections, platformModels: configured.map(({input,output,cachedInput,...r})=>({...r,inputUsd:usdDecimal(input),outputUsd:usdDecimal(output),cachedInputUsd:usdDecimal(cachedInput)})) };
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
    await prepareUsdWallet(ctx.db,accountId);
    const [account]=await ctx.db.select().from(accounts).where(eq(accounts.id,accountId));
    if(account?.moneyUnit!=="usd_micro")return {accountId,conversionRequired:true as const,balance:null,purchases:[],usage:[],models:[],packs:[]};
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
    return {accountId,conversionRequired:false as const,balance:{availableUsd:usdDecimal(balance.availableUnits),reservedUsd:usdDecimal(balance.reservedUnits)},
      purchases:purchases.map(({creditUnits,refundedUnits,...r})=>({...r,balanceUsd:usdDecimal(creditUnits),refundedUsd:usdDecimal(refundedUnits)})),
      usage:usage.map(r=>({category:r.category,amountUsd:usdDecimal(r.units)})),models:models.map(({chargedUnits,...r})=>({...r,chargedUsd:chargedUnits===null?null:usdDecimal(chargedUnits)})),
      packs:config.PADDLE_API_KEY&&config.PADDLE_USD_PACKS_JSON?[...parsePaddleCreditPacks(config.PADDLE_USD_PACKS_JSON).values()].map(r=>({priceId:r.priceId,balanceUsd:usdDecimal(r.creditUnits)})):[]};
  }),
  walletBalance: procedure.query(async ({ctx})=>{const b=await getCreditBalance(ctx.db,accountIdOf(ctx.accountId));return {currency:"USD" as const,availableUsd:usdDecimal(b.availableUnits),reservedUsd:usdDecimal(b.reservedUnits)};}),
  redeemCoupon: procedure.input(z.object({code:z.string().min(3).max(40)})).mutation(({ctx,input})=>redeemBalanceCoupon(ctx.db,accountIdOf(ctx.accountId),input.code)),

  createWalletPurchase: procedure.input(z.object({
    operationId: z.string().trim().min(1).max(200),
    priceId: z.string().trim().min(1).max(100),
    couponCode:z.string().trim().min(3).max(40).optional(),
  })).mutation(async ({ ctx, input }) => {
    const config = loadConfig(process.env);
    if (!config.PADDLE_API_KEY || !config.PADDLE_USD_PACKS_JSON) {
      throw new AppError("paddle_unconfigured", "Paddle billing is not configured");
    }
    const environment = config.PADDLE_ENVIRONMENT
      ?? (config.PADDLE_API_KEY.startsWith("pdl_sdbx_") ? "sandbox" : "live");
    const purchase = await createPaddleCreditPurchase(ctx.db, {
      accountId: accountIdOf(ctx.accountId),
      operationId:input.operationId,priceId:input.priceId,
      ...(input.couponCode?{discountId:await purchaseDiscount(ctx.db,input.couponCode)}:{}),
      ...(config.PADDLE_CHECKOUT_URL ? { checkoutUrl: config.PADDLE_CHECKOUT_URL } : {}),
    }, {
      packs: parsePaddleCreditPacks(config.PADDLE_USD_PACKS_JSON),
      client: createPaddleTransactionClient({ apiKey: config.PADDLE_API_KEY, environment }),
    });
    return {
      id: purchase.id,
      status: purchase.status,
      checkoutUrl: purchase.checkoutUrl,
      balanceUsd: usdDecimal(purchase.creditUnits),
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
