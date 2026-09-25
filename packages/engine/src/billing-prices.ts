import { AppError, newId, usdMicros, scaledAmount } from "@tabductor/core";
import { creditLedgerEntries, billingRates, billingAudit, operatingCosts, accounts, billingSettings, type Db } from "@tabductor/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export async function assertUsdAccount(db: Db, accountId: string) {
  if (!await prepareUsdWallet(db, accountId)) {
    throw new AppError("wallet_conversion_pending", "Your balance will convert to USD automatically after outstanding usage settles.");
  }
}

/** The agreed pre-launch conversion: one old credit is one USD. */
export function legacyCreditUsd() {
  return process.env.LEGACY_CREDIT_USD?.trim() || "1";
}

/** Also used by web requests, so conversion does not require an engine restart. */
export async function prepareUsdWallet(db: Db, accountId: string): Promise<boolean> {
  const [account] = await db.select({unit: accounts.moneyUnit}).from(accounts).where(eq(accounts.id,accountId));
  if (!account || account.unit === "usd_micro") return true;
  try {
    await convertLegacyWallet(db, accountId, "system:usd-conversion");
    return true;
  } catch (error) {
    // In-flight providers retain their original amounts until settlement completes.
    if (error instanceof AppError && error.code === "conversion_active_usage") return false;
    throw error;
  }
}

/** Run at startup and periodically, including for accounts that never sign in again. */
export async function convertLegacyWallets(db: Db): Promise<void> {
  const pending = await db.select({id: accounts.id}).from(accounts).where(and(
    eq(accounts.moneyUnit, "legacy_credit"),
    sql`not exists (select 1 from credit_reservations r where r.account_id=${accounts.id} and r.status='active')`,
  )).orderBy(accounts.id).limit(100);
  const results = await Promise.allSettled(pending.map(account => prepareUsdWallet(db, account.id)));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Some legacy wallets could not be converted automatically");
}
export async function setting(db: Db, key: string) {
  return (await db.select().from(billingSettings).where(eq(billingSettings.key,key)))[0]?.value ?? {};
}
export async function audit(db: Db, actorId: string, action: string, details: Record<string,unknown>) {
  await db.insert(billingAudit).values({id:newId("audit"),actorId,action,details});
}
export async function findBillingRate(db: Db, category: string, provider: string, item: string) {
  const rows = await db.select().from(billingRates).where(and(eq(billingRates.category,category),eq(billingRates.provider,provider),inArray(billingRates.item,[item,"*"]))).orderBy(desc(billingRates.createdAt),desc(billingRates.id));
  return rows.find(r=>r.item===item) ?? rows.find(r=>r.item==="*");
}
export async function recordCost(db: Db, input: {category:string;sourceId:string;accountId?:string;provider?:string;rateId?:string;costMicros:number|null;quantity?:string;occurredAt?:Date}) {
  await db.insert(operatingCosts).values({id:newId("cost"),...input}).onConflictDoNothing({target:[operatingCosts.category,operatingCosts.sourceId]});
}
export async function priceCost(db:Db,input:{category:string;provider:string;item:string;sourceId:string;accountId:string;quantity?:number;divisor?:number}) {
  const rate=await findBillingRate(db,input.category,input.provider,input.item);
  await recordCost(db,{category:input.category,provider:input.provider,sourceId:input.sourceId,accountId:input.accountId,
    ...(rate?{rateId:rate.id}:{}),costMicros:rate?.costMicros==null?null:scaledAmount(input.quantity??1,rate.costMicros,input.divisor??1),quantity:String(input.quantity??1)});
}
/** Account-locked and idempotent; the old ledger remains immutable. */
export async function convertLegacyWallet(db:Db,accountId:string,actorId:string) {
  const raw=legacyCreditUsd();
  const factor=usdMicros(raw);
  if(factor<=0) throw new AppError("conversion_rate_invalid","The conversion rate must be positive.");
  await db.transaction(async trx=>{
    await trx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${accountId},0))`);
    const [account]=await trx.select().from(accounts).where(eq(accounts.id,accountId)).for("update");
    if(!account)throw new AppError("account_not_found","Account not found");
    if(account.moneyUnit==="usd_micro")return;
    const active=await trx.execute(sql`select 1 from credit_reservations where account_id=${accountId} and status='active' limit 1`);
    if(active.rows.length)throw new AppError("conversion_active_usage","Stop work and settle existing reservations before conversion.");
    // Preserve the original ledger and operation amounts in an immutable conversion audit.
    const original=await trx.execute(sql`select jsonb_build_object(
      'ledger',(select coalesce(jsonb_agg(to_jsonb(l)),'[]') from credit_ledger_entries l where account_id=${accountId}),
      'reservations',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from credit_reservations r where account_id=${accountId}),
      'purchases',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from payment_purchases p where account_id=${accountId})
    ) as snapshot`);
    await audit(trx,actorId,"wallet.convert",{accountId,usdPerCredit:raw,original:original.rows[0]?.snapshot});
    // Every dynamically quoted identifier below comes from this fixed implementation list.
    for(const [table,columns,where] of [
      ["credit_reservations",["reserved_units","settled_units"],"account_id"],
      ["payment_purchases",["credit_units","refunded_units"],"account_id"], ["model_operations",["charged_units"],"account_id"],
      ["captcha_jobs",["credit_units"],"account_id"],
    ] as const){
      for(const column of columns){
        const overflow=await trx.execute(sql`select 1 from ${sql.identifier(table)} where ${sql.identifier(where)}=${accountId} and abs(${sql.identifier(column)}::numeric * ${factor}) > ${Number.MAX_SAFE_INTEGER} limit 1`);
        if(overflow.rows.length)throw new AppError("wallet_overflow","Conversion exceeds the supported monetary range");
      }
      await trx.execute(sql`update ${sql.identifier(table)} set ${sql.join(columns.map(c=>sql`${sql.identifier(c)}=${sql.identifier(c)} * ${factor}`),sql`, `)} where ${sql.identifier(where)}=${accountId}`);
    }
    await trx.execute(sql`update payment_adjustments set debited_units=debited_units * ${factor} where purchase_id in (select id from payment_purchases where account_id=${accountId})`);
    await trx.execute(sql`update browser_billing set units_per_minute=units_per_minute * ${factor} where session_id in (select id from browser_sessions where account_id=${accountId})`);
    await trx.execute(sql`update challenge_attempts set credit_units=credit_units * ${factor} where challenge_id in (select id from browser_challenges where account_id=${accountId})`);
    const oldBalance=await trx.execute<{amount:string}>(sql`select coalesce(sum(units),0)::text as amount from credit_ledger_entries where account_id=${accountId} and money_unit='legacy_credit'`);
    const converted=BigInt(oldBalance.rows[0]!.amount)*BigInt(factor);
    if(converted>BigInt(Number.MAX_SAFE_INTEGER)||converted < -BigInt(Number.MAX_SAFE_INTEGER))throw new AppError("wallet_overflow","Converted balance exceeds the supported range");
    if(converted!==0n)await trx.insert(creditLedgerEntries).values({id:newId("money"),accountId,kind:"adjustment",units:Number(converted),idempotencyKey:`usd-conversion:${accountId}`,metadataJson:{reason:"legacy_conversion",currency:"USD",usdPerCredit:raw}});
    await trx.update(accounts).set({moneyUnit:"usd_micro",legacyCreditMicros:factor}).where(eq(accounts.id,accountId));
  });
}
