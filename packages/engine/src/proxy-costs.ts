import { meterAllowance } from "./subscriptions.js";
import { lockCreditAccount } from "./credits.js";
import { proxyAccounts, billingSettings, operatingCosts, type Db } from "@tabductor/db";
import { and, eq, sql } from "drizzle-orm";
import { newId, scaledAmount } from "@tabductor/core";
import { findBillingRate } from "./billing-prices.js";

/** Bounded RFC4180 reader. Unknown report columns fail visibly rather than becoming zero. */
export function parseProxyReport(csv:string):Array<{day:string;bytes:number}>{
  if(csv.length>5_000_000)throw new Error("IPRoyal report exceeds 5 MB");
  const rows:string[][]=[];let row:string[]=[],field="",quoted=false;
  const delimiter=csv.split("\n",1)[0]!.includes(";")?";":",";
  for(let i=0;i<csv.length;i++){const char=csv[i]!;
    if(char==='"'){if(quoted&&csv[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&(char===delimiter||char==='\n')){row.push(field.replace(/\r$/, ""));field="";if(char==='\n'){if(row.some(Boolean))rows.push(row);row=[];}}
    else field+=char;
  }
  if(quoted)throw new Error("Malformed IPRoyal CSV");
  if(field||row.length){row.push(field.replace(/\r$/, ""));rows.push(row);}
  const header=rows.shift()?.map(v=>v.replace(/^\uFEFF/,"").trim().toLowerCase().replace(/[^a-z]/g,""))??[];
  const date=header.findIndex(v=>["date","day"].includes(v));
  const traffic=header.findIndex(v=>["traffic","trafficb","trafficbytes","trafficused","bandwidth","bytes","total","totalb","totalbytes","datausage","datausageb","data"].includes(v));
  if(date<0||traffic<0)throw new Error("Unrecognized IPRoyal report columns; expected date and traffic in bytes");
  const unit=header.findIndex(v=>["measurementunit","unit"].includes(v));
  if(header[traffic]==="data"&&unit<0)throw new Error("IPRoyal data column requires a measurement unit");
  const days=new Map<string,number>();
  for(const r of rows){
    const day=r[date]?.trim()??"",raw=r[traffic]?.trim()??"";
    // Provider CSV includes per-host rows and a final total, which is not another charge.
    if(!day&&r.some(v=>/^total:?$/i.test(v.trim())))continue;
    if(unit>=0&&r[unit]?.trim().toUpperCase()!=="B")throw new Error("IPRoyal report must contain bytes");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day||!/^\d+(?:\.0+)?$/.test(raw))throw new Error("Invalid IPRoyal report row");
    const bytes=Number(raw),total=(days.get(day)??0)+bytes;
    if(!Number.isSafeInteger(bytes)||bytes<0||!Number.isSafeInteger(total))throw new Error("Invalid IPRoyal byte count");
    days.set(day,total);
  }
  return [...days].map(([day,bytes])=>({day,bytes}));
}
export async function syncProxyCosts(db:Db,force=false,request:typeof fetch=fetch){
  const key=process.env.IPROYAL_API_TOKEN;if(!key)return;
  const claimed=await db.transaction(async trx=>{
    await trx.execute(sql`select pg_advisory_xact_lock(hashtextextended('iproyal-sync',0))`);
    const [row]=await trx.select().from(billingSettings).where(eq(billingSettings.key,"iproyal_sync"));
    const at=Number(row?.value.at??0);
    if(Date.now()-at<(row?.value.running?300000:force?5000:300000))return false;
    await trx.insert(billingSettings).values({key:"iproyal_sync",value:{...row?.value,at:Date.now(),running:true}}).onConflictDoUpdate({target:billingSettings.key,set:{value:{...row?.value,at:Date.now(),running:true},updatedAt:new Date()}});return true;
  });
  if(!claimed)return;
  let error:string|null=null;
  try{
    const mappings=await db.select().from(proxyAccounts);
    const until=new Date();
    for(const mapping of mappings){
      const [imported]=await db.select({id:operatingCosts.id}).from(operatingCosts).where(and(eq(operatingCosts.category,"proxy"),sql`${operatingCosts.sourceId} like ${`iproyal:${mapping.hash}:%`}`)).limit(1);
      const from=new Date(until.getTime()-(imported?7:30)*86400000);
      const query=new URLSearchParams({hash:mapping.hash,date_from:from.toISOString().slice(0,10),date_to:until.toISOString().slice(0,10),measurement_unit:"B",rounding_decimal:"0",time_zone:"UTC"});
      const response=await request(`https://resi-api.iproyal.com/v1/residential/data-usage-report?${query}`,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error(`IPRoyal report failed (${response.status})`);
      const report=parseProxyReport(await response.text()),rate=await findBillingRate(db,"proxy","iproyal","GB");
      for(const entry of report){
        const sourceId=`iproyal:${mapping.hash}:${entry.day}`;
        const [previous]=await db.select().from(operatingCosts).where(and(eq(operatingCosts.category,"proxy"),eq(operatingCosts.sourceId,sourceId)));
        // Corrections change byte counts, never the cost rate or owner captured on first import.
        const snapshot=previous?.snapshot??{unitCharge:0,unitCost:rate?.costMicros??null};
        const values={accountId:previous?previous.accountId:mapping.accountId,category:"proxy",provider:"iproyal",sourceId,quantity:String(entry.bytes),snapshot,
          costMicros:snapshot.unitCost===null?null:scaledAmount(entry.bytes,snapshot.unitCost,1_000_000_000),rateId:previous?previous.rateId:rate?.id??null,occurredAt:new Date(`${entry.day}T00:00:00Z`)};
        await db.transaction(async trx => {
          if (mapping.accountId) await lockCreditAccount(trx, mapping.accountId);
          const prior = (await trx.execute<{bytes:string;revision:number}>(sql`select * from proxy_usage_buckets where hash=${mapping.hash} and day=${entry.day} for update`)).rows[0];
          const delta = entry.bytes - Number(prior?.bytes ?? 0);
          if (delta && mapping.accountId) {
            // Only traffic incurred after rollout is customer usage; retain earlier expenses as history.
            const cutover = (await trx.execute<{at:string}>(sql`select value->>'at' as at from billing_settings where key='subscription_cutover'`)).rows[0];
            if (cutover && entry.day >= new Date(cutover.at).toISOString().slice(0,10)) {
              await meterAllowance(trx, mapping.accountId, "proxy", delta, `${sourceId}:${(prior?.revision ?? 0)+1}`);
            }
          }
          await trx.execute(sql`insert into proxy_usage_buckets(hash,day,bytes) values(${mapping.hash},${entry.day},${entry.bytes})
            on conflict(hash,day) do update set bytes=excluded.bytes,revision=proxy_usage_buckets.revision+1`);
          await trx.insert(operatingCosts).values({id:newId("cost"),...values}).onConflictDoUpdate({target:[operatingCosts.category,operatingCosts.sourceId],set:values});
        });
      }
    }
  }catch(cause){error=cause instanceof Error?cause.message:"IPRoyal sync failed";}
  const [prior]=await db.select().from(billingSettings).where(eq(billingSettings.key,"iproyal_sync"));
  await db.update(billingSettings).set({value:{at:Date.now(),running:false,error,lastSuccess:error?prior?.value.lastSuccess??null:new Date().toISOString()},updatedAt:new Date()}).where(eq(billingSettings.key,"iproyal_sync"));
}
