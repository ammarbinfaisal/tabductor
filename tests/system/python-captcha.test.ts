import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { browserSessions, captchaJobs, creditReservations, runs, tasks, workflowExecutions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { appendCreditAdjustment, createBrowserProfile, createCaptchaService, createWorkflow, expireCreditReservations, getCreditBalance, resolveAccountIdentity, type CaptchaProvider, type RunHandle } from "@tabductor/engine";
import { seedWorkflow } from "@tabductor/engine/testing";
import { pythonFixture } from "../../packages/agent/src/python-test-support.js";
import { browserCaptchaTool } from "../../packages/agent/src/browser-captcha.js";

let database: MigratedTestDb;
beforeAll(async()=>{database=await createMigratedTestDb();});
afterAll(async()=>{await database?.close();});
async function fixture(credits=10) {
  const db=database.db, accountId=await resolveAccountIdentity(db,{provider:"fixture",subject:randomUUID()});
  if(credits)await appendCreditAdjustment(db,{accountId,kind:"purchase",units:credits,idempotencyKey:randomUUID()});
  const workflowId=await createWorkflow(db,{name:"CAPTCHA",userId:"local",accountId});
  const wf=await seedWorkflow(db,{workflowId,tasks:{Browse:{kind:"browser",mode:"ai"}}});
  const [task]=await db.select().from(tasks).where(eq(tasks.id,wf.taskIds.Browse!));
  const [run]=await db.insert(runs).values({id:randomUUID(),taskId:task!.id,workflowVersionId:wf.versionId,status:"running",modeUsed:"ai",leaseGeneration:1}).returning();
  const handle:RunHandle={run:run!,task:task!,trigger:null,signal:new AbortController().signal,declaredEmits:async()=>[],emit:async()=>null};
  const provider:CaptchaProvider={name:"capsolver",configured:true,rate:{name:"capsolver",rateVersion:"solver-v1",creditUnits:1},documentation:"https://docs.capsolver.com",
    submit:vi.fn<CaptchaProvider["submit"]>(async()=>({status:"pending",taskId:"native-job"})),poll:vi.fn<CaptchaProvider["poll"]>(async()=>({status:"ready",taskId:"native-job",solution:{token:"solved-token",extra:{native:true}}})),pushVariable:vi.fn(async()=>{})};
  const service=createCaptchaService({db,handle,providers:[provider]});
  return {db,accountId,workflowId,handle,provider,service};
}
const args={provider:"capsolver" as const,task:{type:"AntiTurnstileTaskProxyLess",websiteURL:"https://fixture.test",websiteKey:"observed-key"},idempotency_key:"challenge-one"};
const readyToPoll=async(id:string)=>database.db.update(captchaJobs).set({nextPollAt:new Date(0)}).where(eq(captchaJobs.id,id));

it("reserves once under concurrent submissions, resumes in another service instance, and settles once", async()=>{
  const f=await fixture();
  const jobs=await Promise.all(Array.from({length:5},()=>f.service.createTask(args)));
  expect(new Set(jobs.map(j=>j.id)).size).toBe(1);expect(f.provider.submit).toHaveBeenCalledTimes(1);
  expect(await getCreditBalance(f.db,f.accountId)).toMatchObject({availableUnits:9,reservedUnits:1});
  await readyToPoll(jobs[0]!.id);
  const restarted=createCaptchaService({db:f.db,handle:f.handle,providers:[f.provider]});
  expect(await restarted.getResult(jobs[0]!.id)).toMatchObject({status:"ready",solution:{token:"solved-token",extra:{native:true}}});
  await restarted.getResult(jobs[0]!.id);expect(f.provider.poll).toHaveBeenCalledTimes(1);
  expect(await getCreditBalance(f.db,f.accountId)).toMatchObject({availableUnits:9,reservedUnits:0});
  expect(await restarted.createTask(args)).toMatchObject({status:"ready"});
  await expect(restarted.createTask({...args,task:{type:"Other"}})).rejects.toMatchObject({code:"captcha_idempotency_conflict"});
});

it("does not resubmit ambiguous jobs, even with a new key, and retains their credit holds", async()=>{
  const f=await fixture();vi.mocked(f.provider.submit).mockRejectedValue(new Error("timeout"));
  const job=await f.service.createTask(args);expect(job.status).toBe("uncertain");
  expect(await f.service.createTask({...args,idempotency_key:"another-key"})).toMatchObject({id:job.id,status:"uncertain"});
  expect(f.provider.submit).toHaveBeenCalledTimes(1);
  await f.db.update(creditReservations).set({expiresAt:new Date(0)});
  await expireCreditReservations(f.db);
  expect(await getCreditBalance(f.db,f.accountId)).toMatchObject({reservedUnits:1});
});

it("releases rejected solves and preserves provider failures", async()=>{
  const f=await fixture();vi.mocked(f.provider.submit).mockResolvedValue({status:"failed",errorCode:"ERROR_ZERO_BALANCE"});
  expect(await f.service.createTask(args)).toMatchObject({status:"failed",error_code:"ERROR_ZERO_BALANCE"});
  expect(await getCreditBalance(f.db,f.accountId)).toMatchObject({availableUnits:10,reservedUnits:0});
});

it("retries polling, never submission, after transient provider failures", async()=>{
  const f=await fixture();const job=await f.service.createTask(args);await readyToPoll(job.id);
  vi.mocked(f.provider.poll).mockRejectedValueOnce(new Error("timeout"));
  expect(await f.service.getResult(job.id)).toMatchObject({status:"pending",error_code:"POLL_UNACKNOWLEDGED"});
  await readyToPoll(job.id);expect(await f.service.getResult(job.id)).toMatchObject({status:"ready"});
  expect(f.provider.submit).toHaveBeenCalledTimes(1);
});

it("rejects missing rates, insufficient credit, cancellation and cross-run job access before spending", async()=>{
  const f=await fixture(0);
  await expect(f.service.createTask(args)).rejects.toMatchObject({code:"credit_insufficient"});
  f.provider.rate=undefined;
  expect((await f.service.providers())[0]).toMatchObject({available:false,reason:"missing_internal_rate"});
  await expect(f.service.createTask(args)).rejects.toMatchObject({code:"captcha_rate_missing"});
  expect(f.provider.submit).not.toHaveBeenCalled();
  const funded=await fixture(), job=await funded.service.createTask(args);
  await expect(f.service.getResult(job.id)).rejects.toMatchObject({code:"captcha_job_not_found"});
  await funded.db.update(runs).set({status:"cancelled"}).where(eq(runs.id,funded.handle.run.id));
  await expect(funded.service.getResult(job.id)).rejects.toMatchObject({code:"run_lease_lost"});
  expect(funded.provider.poll).not.toHaveBeenCalled();
});

it("fences submissions during human control and settles acknowledged results after cancellation", async()=>{
  const f=await fixture(), executionId=randomUUID(), sessionId=randomUUID();
  await f.db.insert(workflowExecutions).values({id:executionId,workflowId:f.workflowId,workflowVersionId:f.handle.task.workflowVersionId,maxHops:10});
  const profileId=await createBrowserProfile(f.db,{accountId:f.accountId,name:"CAPTCHA control"});
  await f.db.insert(browserSessions).values({id:sessionId,accountId:f.accountId,profileId,executionId,status:"running",inputOwner:"human"});
  f.handle.run.executionId=executionId;
  await expect(f.service.createTask(args)).rejects.toMatchObject({code:"browser_input_revoked"});
  expect(f.provider.submit).not.toHaveBeenCalled();
  expect(await getCreditBalance(f.db,f.accountId)).toMatchObject({reservedUnits:0});
  await f.db.update(browserSessions).set({inputOwner:"ai"}).where(eq(browserSessions.id,sessionId));
  vi.mocked(f.provider.submit).mockImplementation(async()=>{
    await f.db.update(runs).set({status:"cancelled"}).where(eq(runs.id,f.handle.run.id));
    return {status:"ready",solution:{token:"accepted-before-cancellation"}};
  });
  expect(await f.service.createTask(args)).toMatchObject({status:"ready"});
  expect(await getCreditBalance(f.db,f.accountId)).toMatchObject({availableUnits:9,reservedUnits:0});
  await expect(f.service.getResult((await f.db.select().from(captchaJobs).where(eq(captchaJobs.runId,f.handle.run.id)))[0]!.id)).rejects.toMatchObject({code:"run_lease_lost"});
});

it("exposes native solving through browser.captcha", async()=>{
  const f=await fixture();vi.mocked(f.provider.submit).mockResolvedValue({status:"ready",taskId:"immediate",solution:{text:"native-answer",coordinates:[{x:3,y:4}]}});
  const tool=browserCaptchaTool(f.service);
  expect(await tool.execute({action:"providers"})).toMatchObject({ok:true,value:[{available:true}]});
  expect(await tool.execute({action:"solve",provider:"capsolver"})).toMatchObject({ok:false,error:expect.stringContaining("missing required argument")});
  const result=await tool.execute({action:"solve",provider:"capsolver",task:{type:"ImageToTextTask",body:"base64"},idempotency_key:"tool-job"});
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,value:{status:"ready",solution:{text:"native-answer",coordinates:[{x:3,y:4}]}}});
  expect(f.provider.submit).toHaveBeenCalledTimes(1);
  expect(await getCreditBalance(f.db,f.accountId)).toMatchObject({availableUnits:9,reservedUnits:0});
});

it("keeps pending jobs usable across separate tool calls", async()=>{
  const f=await fixture(), tool=browserCaptchaTool(f.service);
  const first=await tool.execute({action:"solve",provider:"capsolver",task:{type:"TurnstileTask"},idempotency_key:"pending",wait_ms:0});
  expect(first,JSON.stringify(first)).toMatchObject({ok:true,value:{status:"pending"}});
  const [job]=await f.db.select().from(captchaJobs).where(eq(captchaJobs.runId,f.handle.run.id));
  await readyToPoll(job!.id);
  const second=await tool.execute({action:"wait",job_id:job!.id,wait_ms:0});
  expect(second,JSON.stringify(second)).toMatchObject({ok:true,value:{status:"ready",solution:{token:"solved-token"}}});
  expect(f.provider.submit).toHaveBeenCalledTimes(1);
});

it.skipIf(!process.env.CAMOUFOX_TEST_URL)("solves with a browser tool and applies an explicit-render callback in Python", async()=>{
  const {createCamoufoxWorkerDriver}=await import("@tabductor/browser");
  const {pythonTool}=await import("../../packages/agent/src/python-tool.js");
  const {testRunner}=await import("../../packages/agent/src/python-test-support.js");
  const workerUrl=process.env.CAMOUFOX_TEST_URL!, sessionId=`captcha-${randomUUID()}`;
  const token=process.env.CAMOUFOX_TEST_TOKEN??"harness-fixture-token";
  const headers={authorization:`Bearer ${token}`,"content-type":"application/json","x-tabductor-rpc-version":"1"};
  const created=await fetch(`${workerUrl}/v1/sessions`,{method:"POST",headers,body:JSON.stringify({session_id:sessionId,generation:1,profile_dir:sessionId})});
  expect(created.status,await created.text()).toBe(200);
  const connection=await createCamoufoxWorkerDriver({token,sessionId,generation:1}).connect(workerUrl);
  const runner=testRunner().open!({runId:sessionId,leaseGeneration:1});
  try {
    const f=await fixture();vi.mocked(f.provider.submit).mockResolvedValue({status:"ready",taskId:"immediate",solution:{token:"fixture-solved-token"}});
    const page=await connection.createPage();
    const tool=pythonTool({session:{page} as import("@tabductor/browser").RunSession,pythonRunner:runner,emit:async()=>({outcome:"deduped"})});
    const setup=await tool.execute({source:`from playwright.sync_api import expect
page.set_content('''<div id="Capthcadiv"></div><input id="RecaptchaToken" type="hidden"><input id="_QString" type="hidden"><output>Awaiting challenge</output>
<script>
window.turnstile = { render: (container, options) => { document.querySelector(container).textContent = 'Verify you are human'; } };
// Capture the render options before initialization, as an agent can do with an init script.
const originalRender = window.turnstile.render;
window.turnstile.render = function(container, options) { window.observedChallenge = options; return originalRender(container, options); };
window.turnstile.render('#Capthcadiv', {sitekey:'observed-key',callback:function(token) {
 document.querySelector('#RecaptchaToken').value=token;
 document.querySelector('#_QString').value='test';
 document.querySelector('output').textContent='Verification accepted';
}});
</script>''')
key = page.evaluate('mw:() => window.observedChallenge.sitekey')
assert key == 'observed-key'`});
    expect(setup).toMatchObject({ok:true});
    const solved=await browserCaptchaTool(f.service).execute({action:"solve",provider:"capsolver",task:{type:"AntiTurnstileTaskProxyLess",websiteURL:"https://fixture.test",websiteKey:"observed-key"},idempotency_key:"observed-widget"});
    expect(solved).toMatchObject({ok:true,value:{status:"ready"}});
    const solution=(solved as {value:{solution:{token:string}}}).value.solution;
    const result=await tool.execute({source:`page.evaluate('mw:token => window.observedChallenge.callback(token)', ${JSON.stringify(solution.token)})
expect(page.locator('output')).to_have_text('Verification accepted')
assert page.locator('#RecaptchaToken').input_value() == 'fixture-solved-token'
assert page.locator('#_QString').input_value() == 'test'
browser.done()`});
    expect(result,JSON.stringify(result)).toMatchObject({ok:true,terminal:{outcome:"done"}});
    expect(f.provider.submit).toHaveBeenCalledWith(expect.objectContaining({task:expect.objectContaining({websiteKey:"observed-key"})}),expect.any(AbortSignal));
  } finally {
    await runner.close!();await connection.close();
    await fetch(`${workerUrl}/v1/sessions/${sessionId}?generation=1`,{method:"DELETE",headers});
  }
},60000);
