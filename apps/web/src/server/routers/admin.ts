import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { AppError, newId, usdMicros, usdDecimal, loadConfig } from "@tabductor/core";
import { accounts, billingRates, billingSettings, billingAudit, billingCoupons, operatingCosts, proxyAccounts, workflowDeletions } from "@tabductor/db";
import { legacyCreditUsd, audit, convertLegacyWallet, saveCoupon, syncDiscount, syncProxyCosts, parsePaddleCreditPacks, settleCreditReservation } from "@tabductor/engine";
import { adminProcedure } from "../admin.js";
import { router } from "../trpc.js";
const amount=z.string().trim().max(30).refine(value=>{try{usdMicros(value);return true;}catch{return false;}},"Use a nonnegative USD amount with at most six decimal places");
const packs=()=>[...parsePaddleCreditPacks(loadConfig().PADDLE_USD_PACKS_JSON??"[]").keys()];
export const adminRouter=router({
  settings:adminProcedure.query(async ({ctx})=>{
    const [rates,coupons,settings,proxies,deletions,audits]=await Promise.all([
      ctx.db.select().from(billingRates).orderBy(desc(billingRates.createdAt),desc(billingRates.id)),
      ctx.db.select().from(billingCoupons).orderBy(desc(billingCoupons.createdAt)).limit(100),
      ctx.db.select().from(billingSettings),ctx.db.select().from(proxyAccounts),
      ctx.db.select().from(workflowDeletions).orderBy(desc(workflowDeletions.createdAt)).limit(25),
      ctx.db.select({id:billingAudit.id,actorId:billingAudit.actorId,action:billingAudit.action,createdAt:billingAudit.createdAt}).from(billingAudit).orderBy(desc(billingAudit.createdAt)).limit(30),
    ]);
    const latest=new Map<string,typeof rates[number]>();for(const rate of rates){const key=JSON.stringify([rate.category,rate.provider,rate.item]);if(!latest.has(key))latest.set(key,rate);}
    return {rates:[...latest.values()].map(({chargeMicros,costMicros,...r})=>({...r,chargeUsd:usdDecimal(chargeMicros),costUsd:costMicros===null?null:usdDecimal(costMicros)})),coupons,
      welcomeUsd:String(settings.find(s=>s.key==="welcome")?.value.amountUsd??"0"),sync:settings.find(s=>s.key==="iproyal_sync")?.value??{},proxies,deletions,audits,
      proxyConfigured:Boolean(process.env.IPROYAL_API_TOKEN),summaryConfigured:Boolean(process.env.OPENAI_API_KEY)};
  }),
  saveRate:adminProcedure.input(z.object({category:z.enum(["browser","solver","model","proxy"]),provider:z.string().trim().max(100),item:z.string().trim().min(1).max(240),chargeUsd:amount,costUsd:amount.nullable(),
    maxInputTokens:z.number().int().min(1024).max(2_000_000).optional(),maxOutputTokens:z.number().int().min(1).max(2_000_000).optional()})).mutation(async ({ctx,input})=>{
    const chargeMicros=usdMicros(input.chargeUsd),costMicros=input.costUsd===null?null:usdMicros(input.costUsd),modelInput=input.category==="model"&&input.item.endsWith(":input");
    if(input.category!=="proxy"&&chargeMicros<=0&&!(input.category==="model"&&input.item.endsWith(":cached")))throw new AppError("price_invalid","The customer price must be positive");
    if(input.category==="browser"&&(input.provider||input.item!=="minute"))throw new AppError("price_invalid","Browser rates use an empty provider and item minute");
    if(input.category==="solver"&&!["capsolver","2captcha","anti-captcha"].includes(input.provider))throw new AppError("price_invalid","Select a supported CAPTCHA provider");
    if(input.category==="model"&&(!["openai","anthropic"].includes(input.provider)||!/^.+:(input|cached|output)$/.test(input.item)))throw new AppError("price_invalid","Model items use model-id:input, model-id:cached or model-id:output");
    if(modelInput&&(input.maxInputTokens===undefined||input.maxOutputTokens===undefined))throw new AppError("price_invalid","Model input rates require maximum input and output token limits");
    if(!modelInput&&(input.maxInputTokens!==undefined||input.maxOutputTokens!==undefined))throw new AppError("price_invalid","Token limits belong on a model-id:input rate");
    if(input.category==="proxy"&&(input.provider!=="iproyal"||input.item!=="GB"))throw new AppError("price_invalid","Proxy costs use provider iproyal and item GB");
    return ctx.db.transaction(async trx=>{const id=newId("rate");await trx.insert(billingRates).values({id,category:input.category,provider:input.provider,item:input.item,chargeMicros,costMicros,
      ...(modelInput?{maxInputTokens:input.maxInputTokens,maxOutputTokens:input.maxOutputTokens}:{})});await audit(trx,ctx.accountId,"rate.create",{...input,id});return {id};});
  }),
  saveModelRates:adminProcedure.input(z.object({provider:z.enum(["openai","anthropic"]),model:z.string().trim().min(1).max(220),
    inputUsd:amount,cachedInputUsd:amount,outputUsd:amount,inputCostUsd:amount.nullable(),cachedInputCostUsd:amount.nullable(),outputCostUsd:amount.nullable(),
    maxInputTokens:z.number().int().min(1024).max(2_000_000),maxOutputTokens:z.number().int().min(1).max(2_000_000)})).mutation(async ({ctx,input})=>{
    const prices={input:usdMicros(input.inputUsd),cached:usdMicros(input.cachedInputUsd),output:usdMicros(input.outputUsd)};
    if(prices.input<=0||prices.output<=0)throw new AppError("price_invalid","Model input and output prices must be positive");
    const costs={input:input.inputCostUsd===null?null:usdMicros(input.inputCostUsd),cached:input.cachedInputCostUsd===null?null:usdMicros(input.cachedInputCostUsd),output:input.outputCostUsd===null?null:usdMicros(input.outputCostUsd)};
    return ctx.db.transaction(async trx=>{const ids={input:newId("rate"),cached:newId("rate"),output:newId("rate")};
      await trx.insert(billingRates).values((["input","cached","output"] as const).map(part=>({id:ids[part],category:"model",provider:input.provider,item:`${input.model}:${part}`,chargeMicros:prices[part],costMicros:costs[part],
        ...(part==="input"?{maxInputTokens:input.maxInputTokens,maxOutputTokens:input.maxOutputTokens}:{})})));
      await audit(trx,ctx.accountId,"model_rates.create",{...input,ids});return {ids};});
  }),
  welcome:adminProcedure.input(z.object({amountUsd:amount})).mutation(({ctx,input})=>ctx.db.transaction(async trx=>{
    await trx.insert(billingSettings).values({key:"welcome",value:input}).onConflictDoUpdate({target:billingSettings.key,set:{value:input,updatedAt:new Date()}});await audit(trx,ctx.accountId,"welcome.update",input);return {saved:true};
  })),
  convertWallet:adminProcedure.input(z.object({accountId:z.string().min(1)})).mutation(async ({ctx,input})=>{await convertLegacyWallet(ctx.db,input.accountId,ctx.accountId);return {converted:true};}),
  createCoupon:adminProcedure.input(z.object({code:z.string().min(3).max(40),kind:z.enum(["balance","percent","flat"]),amount,maxRedemptions:z.number().int().positive().nullable(),expiresAt:z.date().nullable()})).mutation(async ({ctx,input})=>{
    if(input.kind!=="balance"&&!process.env.PADDLE_API_KEY)throw new AppError("paddle_unconfigured","Configure Paddle before creating purchase discounts");
    const priceIds=input.kind==="balance"?[]:packs();
    const code=await saveCoupon(ctx.db,ctx.accountId,input);if(input.kind!=="balance")await syncDiscount(ctx.db,code,priceIds);return {code};
  }),
  couponStatus:adminProcedure.input(z.object({code:z.string().min(3).max(40),disabled:z.boolean()})).mutation(async ({ctx,input})=>{
    await ctx.db.transaction(async trx=>{await trx.update(billingCoupons).set({disabled:input.disabled}).where(eq(billingCoupons.code,input.code));await audit(trx,ctx.accountId,"coupon.status",input);});
    const [coupon]=await ctx.db.select().from(billingCoupons).where(eq(billingCoupons.code,input.code));
    if(coupon&&coupon.kind!=="balance")await syncDiscount(ctx.db,input.code,packs());return {saved:true};
  }),
  retryCoupon:adminProcedure.input(z.object({code:z.string()})).mutation(async ({ctx,input})=>{await syncDiscount(ctx.db,input.code,packs());return {synced:true};}),
  expense:adminProcedure.input(z.object({amountUsd:amount,description:z.string().trim().min(1).max(200),accountId:z.string().min(1).optional(),date:z.date(),operationId:z.string().min(1).max(100)})).mutation(async ({ctx,input})=>{
    await ctx.db.transaction(async trx=>{if(input.accountId&&!(await trx.select().from(accounts).where(eq(accounts.id,input.accountId)))[0])throw new AppError("account_not_found","Account not found");
      const inserted=await trx.insert(operatingCosts).values({id:newId("cost"),accountId:input.accountId??null,category:"overhead",provider:input.description,sourceId:input.operationId,costMicros:usdMicros(input.amountUsd),occurredAt:input.date}).onConflictDoNothing().returning();
      if(!inserted.length){const [prior]=await trx.select().from(operatingCosts).where(and(eq(operatingCosts.category,"overhead"),eq(operatingCosts.sourceId,input.operationId)));
        if(!prior||prior.costMicros!==usdMicros(input.amountUsd)||prior.provider!==input.description||prior.accountId!==(input.accountId??null)||prior.occurredAt.getTime()!==input.date.getTime())throw new AppError("expense_conflict","This expense ID already has different details");}
      if(inserted.length)await audit(trx,ctx.accountId,"expense.create",{...input,date:input.date.toISOString()});});return {saved:true};
  }),
  mapProxy:adminProcedure.input(z.object({hash:z.string().trim().regex(/^[a-zA-Z0-9_-]{5,150}$/),label:z.string().trim().min(1).max(120),accountId:z.string().min(1).nullable()})).mutation(({ctx,input})=>ctx.db.transaction(async trx=>{
    if(input.accountId&&!(await trx.select().from(accounts).where(eq(accounts.id,input.accountId)))[0])throw new AppError("account_not_found","Account not found");
    await trx.insert(proxyAccounts).values(input).onConflictDoUpdate({target:proxyAccounts.hash,set:input});await audit(trx,ctx.accountId,"proxy.map",input);return {saved:true};
  })),
  syncProxy:adminProcedure.mutation(async ({ctx})=>{await audit(ctx.db,ctx.accountId,"proxy.sync",{});await syncProxyCosts(ctx.db,true);return {requested:true};}),
  pendingCharges:adminProcedure.query(async ({ctx})=>{
    const result=await ctx.db.execute<{id:string;account_id:string;category:string;amount:string;created_at:Date}>(sql`select c.id,c.account_id,c.category,c.reserved_units::text as amount,c.created_at from credit_reservations c where c.status='active' and c.category in ('solver','model') and c.created_at < now()-interval '5 minutes' order by c.created_at limit 100`);
    return Promise.all(result.rows.map(async ({amount,...row})=>{const [account]=await ctx.db.select().from(accounts).where(eq(accounts.id,row.account_id));return {...row,reservedUsd:account?.moneyUnit==="usd_micro"?usdDecimal(Number(amount)):null,legacyUnits:account?.moneyUnit==="legacy_credit"?amount:null};}));
  }),
  reconcileCharge:adminProcedure.input(z.object({reservationId:z.string().min(1),amountUsd:amount,providerCostUsd:amount.nullable(),reason:z.string().trim().min(10).max(500)})).mutation(async ({ctx,input})=>ctx.db.transaction(async trx=>{
    const result=await trx.execute<{account_id:string;reserved_units:string;status:string}>(sql`select account_id,reserved_units::text,status from credit_reservations where id=${input.reservationId} and category in ('solver','model') and created_at < now()-interval '5 minutes' for update`);
    const reservation=result.rows[0];if(!reservation)throw new AppError("reconciliation_not_ready","Only model or CAPTCHA reservations older than five minutes can be reconciled");
    const [account]=await trx.select().from(accounts).where(eq(accounts.id,reservation.account_id));
    let units=usdMicros(input.amountUsd);
    if(account?.moneyUnit==="legacy_credit"){
      const factor=usdMicros(legacyCreditUsd());
      if(!factor)throw new AppError("conversion_rate_required","The legacy USD conversion rate must be positive");
      if(units%factor!==0)throw new AppError("legacy_amount_invalid","The confirmed USD charge must correspond to a whole number of legacy credits");
      units/=factor;
    }
    if(units>Number(reservation.reserved_units))throw new AppError("reconciliation_amount_invalid","The charge cannot exceed the reserved amount");
    if(reservation.status!=="active")return {settled:true};
    const running=await trx.execute(sql`select 1 from runs where status='running' and id in (
      select run_id from model_operations where reservation_id=${input.reservationId}
      union all select run_id from captcha_jobs where reservation_id=${input.reservationId}) limit 1`);
    if(running.rows.length)throw new AppError("reconciliation_active_run","Stop the active run before reconciling its charge");
    await settleCreditReservation(trx,{accountId:reservation.account_id,reservationId:input.reservationId,actualUnits:units});
    await trx.execute(sql`update model_operations set status='succeeded',charged_units=${units},completed_at=now() where reservation_id=${input.reservationId}`);
    await trx.execute(sql`update captcha_jobs set status='failed',error_code='ADMIN_RECONCILED' where reservation_id=${input.reservationId}`);
    await trx.execute(sql`update challenge_attempts set status='invalid' where reservation_id=${input.reservationId}`);
    const priorCost=await trx.execute(sql`select id from operating_costs where source_id=${input.reservationId} or (category='model' and source_id in(select id from model_operations where reservation_id=${input.reservationId}))`);
    if(!priorCost.rows.length)await trx.insert(operatingCosts).values({id:newId("cost"),accountId:reservation.account_id,category:"reconciliation",sourceId:input.reservationId,costMicros:null});
    const observed=await trx.execute(sql`update operating_costs set cost_micros=${input.providerCostUsd===null?null:usdMicros(input.providerCostUsd)},status='settled' where source_id=${input.reservationId} or (category='model' and source_id in(select id from model_operations where reservation_id=${input.reservationId})) returning id`);
    if(!observed.rows.length)throw new Error("Missing reconciliation cost record");
    await audit(trx,ctx.accountId,"charge.reconcile",input);return {settled:true};
  })),
  users:adminProcedure.input(z.object({page:z.number().int().min(0).max(100000).default(0),query:z.string().trim().max(100).default("")})).query(async ({ctx,input})=>{
    const rows=await ctx.db.execute<{id:string;name:string;money_unit:string;available:string;reserved:string;spent:string;byo:boolean}>(sql`select a.id,a.name,a.money_unit,
      coalesce((select sum(units)::text from credit_ledger_entries where account_id=a.id and money_unit=a.money_unit),'0') as available,
      coalesce((select sum(reserved_units)::text from credit_reservations where account_id=a.id and status='active'),'0') as reserved,
      coalesce((select sum(settled_units)::text from credit_reservations where account_id=a.id and status='settled'),'0') as spent,
      exists(select 1 from model_credentials where account_id=a.id and revoked_at is null) as byo
      from accounts a where a.id ilike ${`%${input.query}%`} or a.name ilike ${`%${input.query}%`} order by a.id limit 26 offset ${input.page*25}`);
    return {items:rows.rows.slice(0,25).map(r=>({id:r.id,name:r.name,moneyUnit:r.money_unit,byo:r.byo,availableUsd:r.money_unit==="usd_micro"?usdDecimal(Number(r.available)):null,reservedUsd:r.money_unit==="usd_micro"?usdDecimal(Number(r.reserved)):null,spentUsd:r.money_unit==="usd_micro"?usdDecimal(Number(r.spent)):null})),hasMore:rows.rows.length>25};
  }),
  overview:adminProcedure.input(z.object({page:z.number().int().min(0).max(100000).default(0),from:z.date(),to:z.date(),accountId:z.string().optional(),category:z.string().max(40).optional(),provider:z.string().max(100).optional(),funding:z.enum(["byo","platform"]).optional()}).refine(v=>v.from<v.to&&v.to.getTime()-v.from.getTime()<=366*86400000,"Choose a range of at most 366 days")).query(async ({ctx,input})=>{
    const {from,to,accountId}=input;
    const owner=accountId?sql`and account_id=${accountId}`:sql``;
    const category=input.category?sql`and category=${input.category}`:sql``;
    const provider=input.provider?sql`and provider=${input.provider}`:sql``;
    const funding=input.funding?sql`and funding=${input.funding}`:sql``;
    const [sales,refunds,usage,costs,byo,models,recent,redemptions,untracked,quantities]=await Promise.all([
      ctx.db.execute<{currency:string;gross:string;fee:string;tax:string;missing:number}>(sql`select currency_code as currency,sum(total_minor)::text as gross,
        coalesce(sum((financial_json->'totals'->>'fee')::numeric),0)::text as fee,
        coalesce(sum((financial_json->'totals'->>'tax')::numeric),0)::text as tax,
        count(*) filter(where financial_json->'totals'->>'fee' is null or financial_json->'totals'->>'tax' is null)::int as missing
        from payment_purchases where credited_at>=${from} and credited_at<${to} ${owner} group by currency_code`),
      ctx.db.execute<{currency:string;amount:string}>(sql`select a.currency_code as currency,sum(a.amount_minor)::text as amount from payment_adjustments a join payment_purchases p on p.id=a.purchase_id where a.status='approved' and a.updated_at>=${from} and a.updated_at<${to} ${accountId?sql`and p.account_id=${accountId}`:sql``} group by a.currency_code`),
      ctx.db.execute<{day:string;category:string;amount:string;operations:number}>(sql`select to_char(settled_at at time zone 'UTC','YYYY-MM-DD') as day,category,sum(settled_units)::text as amount,count(*)::int as operations from credit_reservations where status='settled' and settled_at>=${from} and settled_at<${to} ${owner} ${category} and account_id in(select id from accounts where money_unit='usd_micro') group by day,category order by day`),
      ctx.db.execute<{category:string;amount:string;unknown:number}>(sql`select category,coalesce(sum(cost_micros),0)::text as amount,count(*) filter(where cost_micros is null)::int as unknown from operating_costs where status='settled' and occurred_at>=${from} and occurred_at<${to} ${owner} ${category} ${provider} group by category`),
      ctx.db.execute<{configured:number;active:number;total:number}>(sql`select (select count(distinct account_id)::int from model_credentials where revoked_at is null ${owner}) as configured,
        (select count(distinct account_id)::int from model_operations where funding='byo' and completed_at>=${from} and completed_at<${to} ${owner}) as active,
        (select count(*)::int from accounts ${accountId?sql`where id=${accountId}`:sql``}) as total`),
      ctx.db.execute<{provider:string;model:string;funding:string;calls:number;input:string;output:string}>(sql`select provider,model,funding,count(*)::int as calls,coalesce(sum(input_tokens),0)::text as input,coalesce(sum(output_tokens),0)::text as output from model_operations where created_at>=${from} and created_at<${to} ${owner} ${provider} ${funding} group by provider,model,funding order by calls desc limit 100`),
      ctx.db.execute<{id:string;account_id:string;category:string;status:string;reserved_units:string;settled_units:string|null;created_at:Date}>(sql`select id,account_id,category,status,reserved_units::text,settled_units::text,created_at from credit_reservations where created_at>=${from} and created_at<${to} ${owner} ${category} and account_id in(select id from accounts where money_unit='usd_micro') order by created_at desc,id desc limit 51 offset ${input.page*50}`),
      ctx.db.execute<{code:string;redemptions:number}>(sql`select code,count(*)::int as redemptions from coupon_redemptions where created_at>=${from} and created_at<${to} ${owner} group by code`),
      ctx.db.execute<{count:number}>(sql`select count(*)::int as count from credit_reservations r where r.status='settled' and r.settled_units>0 and r.settled_at>=${from} and r.settled_at<${to} ${accountId?sql`and r.account_id=${accountId}`:sql``} and not exists(select 1 from operating_costs c where c.source_id=r.id or (c.category='model' and c.source_id in(select id from model_operations where reservation_id=r.id)))`),
      ctx.db.execute<{category:string;provider:string;item:string;quantity:string}>(sql`select c.category,c.provider,coalesce(r.item,'Unspecified') as item,sum(c.quantity::numeric)::text as quantity from operating_costs c left join billing_rates r on r.id=c.rate_id where c.status='settled' and c.category in ('solver','browser','proxy') and c.occurred_at>=${from} and c.occurred_at<${to} ${accountId?sql`and c.account_id=${accountId}`:sql``} ${input.category?sql`and c.category=${input.category}`:sql``} ${input.provider?sql`and c.provider=${input.provider}`:sql``} group by c.category,c.provider,r.item`),
    ]);
    return {untrackedCosts:untracked.rows[0]!.count,quantities:quantities.rows,hasMore:recent.rows.length>50,sales:sales.rows.map(r=>({...r,refunds:refunds.rows.find(a=>a.currency===r.currency)?.amount??"0"})),refunds:refunds.rows,
      usage:usage.rows.map(({amount,...r})=>({...r,amountUsd:usdDecimal(Number(amount))})),costs:costs.rows.map(({amount,...r})=>({...r,amountUsd:usdDecimal(Number(amount))})),byo:byo.rows[0]!,models:models.rows,
      recent:recent.rows.slice(0,50).map(r=>({id:r.id,accountId:r.account_id,category:r.category,status:r.status,reservedUsd:usdDecimal(Number(r.reserved_units)),spentUsd:r.settled_units===null?null:usdDecimal(Number(r.settled_units)),createdAt:r.created_at})),redemptions:redemptions.rows};
  }),
});
