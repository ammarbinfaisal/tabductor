import { AppError, usdMicros } from "@tabductor/core";
import { billingCoupons, couponRedemptions, type Db } from "@tabductor/db";
import { and, eq, sql } from "drizzle-orm";
import { appendCreditAdjustmentLocked, lockCreditAccount } from "./credits.js";
import { assertUsdAccount, audit } from "./billing-prices.js";

export function couponCode(value:string){const code=value.trim().toUpperCase();if(!/^[A-Z0-9_-]{3,40}$/.test(code))throw new AppError("coupon_invalid","Use 3–40 letters, numbers, hyphens or underscores");return code;}
export async function redeemBalanceCoupon(db:Db,accountId:string,value:string){
  await assertUsdAccount(db,accountId);
  const code=couponCode(value);
  return db.transaction(async trx=>{
    await lockCreditAccount(trx,accountId);
    const [coupon]=await trx.select().from(billingCoupons).where(eq(billingCoupons.code,code)).for("update");
    const [prior]=await trx.select().from(couponRedemptions).where(and(eq(couponRedemptions.code,code),eq(couponRedemptions.accountId,accountId)));
    if(prior)return {redeemed:true,alreadyRedeemed:true};
    if(!coupon||coupon.kind!=="balance"||coupon.disabled||coupon.expiresAt&&coupon.expiresAt<=new Date())throw new AppError("coupon_unavailable","This balance coupon is unavailable or expired");
    const [count]=await trx.select({n:sql<number>`count(*)::int`}).from(couponRedemptions).where(eq(couponRedemptions.code,code));
    if(coupon.maxRedemptions!==null&&count!.n>=coupon.maxRedemptions)throw new AppError("coupon_limit","This coupon has reached its redemption limit");
    await appendCreditAdjustmentLocked(trx,{accountId,kind:"adjustment",units:usdMicros(coupon.amount),idempotencyKey:`coupon:${code}:${accountId}`,metadata:{reason:"coupon",code,currency:"USD"}});
    await trx.insert(couponRedemptions).values({code,accountId});
    return {redeemed:true,alreadyRedeemed:false};
  });
}
export async function purchaseDiscount(db:Db,value:string){
  const [coupon]=await db.select().from(billingCoupons).where(eq(billingCoupons.code,couponCode(value)));
  if(!coupon||coupon.kind==="balance"||coupon.disabled||!coupon.paddleId||coupon.syncError||coupon.expiresAt&&coupon.expiresAt<=new Date())throw new AppError("coupon_unavailable","This purchase discount is unavailable or expired");
  return coupon.paddleId;
}
export function paddleApiConfig(){
  const key=process.env.PADDLE_API_KEY;
  if(!key)throw new AppError("paddle_unconfigured","Configure Paddle before managing purchase discounts");
  const environment=process.env.PADDLE_ENVIRONMENT||(key.startsWith("pdl_sdbx_")?"sandbox":"live");
  return {key,url:environment==="sandbox"?"https://sandbox-api.paddle.com":"https://api.paddle.com"};
}
export async function syncDiscount(db:Db,code:string,priceIds:string[],request:typeof fetch=fetch){
  const [coupon]=await db.select().from(billingCoupons).where(eq(billingCoupons.code,code));
  if(!coupon||coupon.kind==="balance")return;
  const {key,url}=paddleApiConfig();
  try{
    // Reconcile an interrupted POST by unique code before attempting another creation.
    let paddleId=coupon.paddleId;
    if(!paddleId){
      const found=await request(`${url}/discounts?code=${encodeURIComponent(code)}&status=active,archived`,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000)});
      if(!found.ok)throw new Error(`Paddle lookup failed (${found.status})`);
      const body=await found.json() as {data?:Array<{id:string;code:string}>};paddleId=body.data?.find(d=>d.code.toUpperCase()===code)?.id??null;
    }
    if(!paddleId&&coupon.disabled){await db.update(billingCoupons).set({syncError:null}).where(eq(billingCoupons.code,code));return;}
    const response=await request(`${url}/discounts${paddleId?`/${paddleId}`:""}`,{method:paddleId?"PATCH":"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},signal:AbortSignal.timeout(15000),
      body:JSON.stringify({description:`Tabductor ${code}`,code,type:coupon.kind==="percent"?"percentage":"flat",amount:coupon.kind==="percent"?coupon.amount:String(usdMicros(coupon.amount)/10000),
        ...(coupon.kind==="flat"?{currency_code:"USD"}:{}),enabled_for_checkout:true,recur:false,...(paddleId?{status:coupon.disabled?"archived":"active"}:{}),
        expires_at:coupon.expiresAt?.toISOString()??null,usage_limit:coupon.maxRedemptions,restrict_to:priceIds})});
    if(!response.ok)throw new Error(`Paddle discount update failed (${response.status})`);
    const body=await response.json() as {data?:{id?:string}};
    if(!body.data?.id)throw new Error("Invalid Paddle discount response");
    await db.update(billingCoupons).set({paddleId:body.data.id,syncError:null}).where(eq(billingCoupons.code,code));
  }catch(error){await db.update(billingCoupons).set({syncError:error instanceof Error?error.message:"Discount sync failed"}).where(eq(billingCoupons.code,code));throw error;}
}
export async function saveCoupon(db:Db,actorId:string,input:{code:string;kind:"balance"|"percent"|"flat";amount:string;maxRedemptions:number|null;expiresAt:Date|null}){
  const code=couponCode(input.code),amount=usdMicros(input.amount);
  if(input.kind!=="balance"&&!/^[A-Z0-9]{3,32}$/.test(code))throw new AppError("coupon_code_invalid","Paddle discount codes use 3–32 letters or numbers");
  if(input.kind==="percent"&&amount<10000)throw new AppError("coupon_amount_invalid","Percentage discounts must be at least 0.01%");
  if(amount<=0||input.kind==="percent"&&amount>100_000_000||input.kind==="flat"&&amount%10000!==0)throw new AppError("coupon_amount_invalid","Use a positive amount, at most 100% for a percentage, and whole cents for a purchase discount");
  await db.transaction(async trx=>{
    await trx.insert(billingCoupons).values({...input,code});
    await audit(trx,actorId,"coupon.create",{...input,code,expiresAt:input.expiresAt?.toISOString()??null});
  });
  return code;
}
