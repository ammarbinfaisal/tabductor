import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelOperations } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { fileKeyWrapper } from "@tabductor/secrets";
import { appendCreditAdjustment, applyOpenAICostBucket, createModelResolver, ensureManagedOpenAIKey, getCreditBalance, getEntitlement, resolveAccountIdentity, setModelSelection, saveModelCredential, transitionEntitlement } from "@tabductor/engine";
import { eq, sql } from "drizzle-orm";
import { createCaller } from "../../apps/web/src/server/router.js";
let db: MigratedTestDb, dir: string;
let serviceCount=0,keyCount=0;
const services:Array<{id:string;name:string}>=[],keys:Array<{id:string;owner:{service_account:{id:string}}}>=[];
let loseServiceResponse=false,loseKeyResponse=false;
const provider=vi.fn(async (url: string|URL|Request, init?:RequestInit) => {
  const path=String(url),body=init?.body?JSON.parse(String(init.body)):{};
  if(path.includes('/service_accounts?'))return Response.json({data:services,has_more:false});
  if(path.includes('/api_keys?'))return Response.json({data:keys,has_more:false});
  if(init?.method==='DELETE'){const index=keys.findIndex(k=>path.endsWith(k.id));keys.splice(index,1);return Response.json({deleted:true});}
  if(path.endsWith('/service_accounts')){const s={id:`sa_${++serviceCount}`,name:body.name};services.push(s);if(loseServiceResponse){loseServiceResponse=false;throw new Error('timeout');}return Response.json(s);}
  if(path.endsWith('/api_keys')){const id=`key_${++keyCount}`;keys.push({id,owner:{service_account:{id:path.split('/').at(-2)!}}});if(loseKeyResponse){loseKeyResponse=false;throw new Error('timeout');}return Response.json({id,value:`managed-fixture-${id}`});}
  throw new Error('Unexpected provider call');
});
beforeAll(async()=>{db=await createMigratedTestDb();dir=await mkdtemp(join(tmpdir(),'managed-openai-'));});
afterAll(async()=>{await db?.close();if(dir)await rm(dir,{recursive:true});});
beforeEach(()=>{vi.stubEnv('OPENAI_ADMIN_KEY','fixture-admin');vi.stubEnv('OPENAI_PROJECT_ID','proj_fixture');vi.stubGlobal('fetch',provider);});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();provider.mockClear();});
const wrapper=()=>fileKeyWrapper(join(dir,'kek.json'));
const account=(subject:string)=>resolveAccountIdentity(db.db,{provider:'fixture',subject});
const resolver=()=>createModelResolver({db:db.db,wrapper:wrapper(),rates:[],platformKeys:{}});
it('removes customer credential mutations and rejects arbitrary or disabled models',async()=>{
  const id=await account('catalog');
  await expect(saveModelCredential(db.db,wrapper(),{accountId:id,provider:'openai',label:'old',apiKey:'fixture'})).rejects.toMatchObject({code:'managed_models_only'});
  await expect(setModelSelection(db.db,id,{funding:'platform',provider:'openai',model:'unapproved'})).rejects.toMatchObject({code:'model_unavailable'});
  const settings=await createCaller({db:db.db,accountId:id}).account.modelSettings();
  expect(settings).not.toHaveProperty('credentials');
  expect(settings.platformModels.map(m=>m.model)).toEqual(['gpt-5.4','gpt-5.6-sol','gpt-5.6-terra']);
});
it('requires positive funding, uses generated keys, and defers all charges to provider buckets',async()=>{
  const id=await account('provider-cost');const invoke=vi.fn(async config=>({value:config.model,usage:{input:100,output:20}}));
  await expect(resolver().execute({accountId:id,purpose:'runtime'},{inputTokenBound:10},invoke)).rejects.toMatchObject({code:'credit_insufficient'});
  expect(provider).not.toHaveBeenCalled();
  await appendCreditAdjustment(db.db,{accountId:id,kind:'purchase',units:100,idempotencyKey:'fund-cost'});
  expect(await resolver().execute({accountId:id,purpose:'runtime'},{operationId:'managed-call',inputTokenBound:10},invoke)).toBe('gpt-5.4');
  expect(invoke.mock.calls[0]![0].apiKey).toMatch(/^managed-fixture-/);
  expect((await getCreditBalance(db.db,id)).availableUnits).toBe(100);
  const key=await ensureManagedOpenAIKey(db.db,wrapper(),id);
  const bucket={apiKeyId:key.api_key_id!,start:100000,end:186400,micros:150};
  await Promise.all([applyOpenAICostBucket(db.db,bucket),applyOpenAICostBucket(db.db,bucket)]);
  expect((await getCreditBalance(db.db,id)).availableUnits).toBe(-50);
  await expect(resolver().execute({accountId:id,purpose:'runtime'},{inputTokenBound:10},invoke)).rejects.toMatchObject({code:'credit_insufficient'});
  await applyOpenAICostBucket(db.db,{...bucket,micros:75});
  expect((await getCreditBalance(db.db,id)).availableUnits).toBe(25);
  const [op]=await db.db.select().from(modelOperations).where(eq(modelOperations.id,'managed-call'));
  expect(op).toMatchObject({chargedUnits:null,reservationId:null,status:'succeeded'});
});
it('recovers lost service and key responses, including concurrent retries',async()=>{
  const id=await account('recovery');const before=serviceCount;
  loseServiceResponse=true;
  await expect(ensureManagedOpenAIKey(db.db,wrapper(),id)).rejects.toThrow();
  loseKeyResponse=true;
  await expect(ensureManagedOpenAIKey(db.db,wrapper(),id)).rejects.toThrow();
  const [a,b]=await Promise.all([ensureManagedOpenAIKey(db.db,wrapper(),id),ensureManagedOpenAIKey(db.db,wrapper(),id)]);
  expect(a.api_key_id).toBe(b.api_key_id);expect(serviceCount-before).toBe(1);
  expect(keys.filter(k=>k.owner.service_account.id===a.service_account_id)).toHaveLength(1);
  expect(JSON.stringify(a.envelope)).not.toContain('managed-fixture');
});
it('rotates on transitions and attributes late charges to the old revision',async()=>{
  const id=await account('transition');await getEntitlement(db.db,id);
  const old=await ensureManagedOpenAIKey(db.db,wrapper(),id);
  await db.db.transaction(async trx=>{await transitionEntitlement(trx,id,'developer_v1',new Date(),'test');await trx.execute(sql`update account_subscriptions set plan_revision_id='developer_v1' where account_id=${id}`);});
  const next=await ensureManagedOpenAIKey(db.db,wrapper(),id);
  expect(next.api_key_id).not.toBe(old.api_key_id);
  await applyOpenAICostBucket(db.db,{apiKeyId:old.api_key_id!,start:200000,end:286400,micros:5});
  expect((await db.db.execute<{plan_revision_id:string}>(sql`select plan_revision_id from provider_cost_buckets where api_key_id=${old.api_key_id}`)).rows[0]!.plan_revision_id).toBe('free_v1');
});
it('admits an idempotent model operation only once despite concurrent retries',async()=>{
  const id=await account('one-operation');await appendCreditAdjustment(db.db,{accountId:id,kind:'purchase',units:100,idempotencyKey:'one-fund'});
  const invoke=vi.fn(async()=>{throw new Error('private provider response');});
  await Promise.allSettled(Array.from({length:5},()=>resolver().execute({accountId:id,purpose:'runtime'},{operationId:'one-operation',inputTokenBound:10},invoke)));
  expect(invoke).toHaveBeenCalledTimes(1);expect((await getCreditBalance(db.db,id)).availableUnits).toBe(100);
});
