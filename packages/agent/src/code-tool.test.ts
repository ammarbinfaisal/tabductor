import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { TraceRecorder, RunSession } from "@tabductor/browser";
import { codeTool } from "./code-tool.js";
import { buildBrowserCodeTools, buildToolRegistry, defineTool } from "./tools.js";
import { readSdkEvidence } from "@tabductor/compiler";
import { AppError } from "@tabductor/core";
import { pythonFixture, testRunner } from "./python-test-support.js";
import { runAgentLoop } from "./loop.js";
import type { CaptchaService } from "@tabductor/engine";

function fixture(compiled = false) {
  const entries: Array<{seq:number;kind:string;payload:Record<string,unknown>}> = [];
  const trace: TraceRecorder = { record:async (kind,payload)=>{entries.push({seq:entries.length,kind,payload});}, flush:vi.fn(async()=>{}), close:async()=>{} };
  let journal: unknown = null;
  const progress = {get:async()=>journal,set:async(v:unknown)=>{journal=v;}};
  const writes = vi.fn(async (_args: unknown)=>({ok:true as const,value:{written:true}}));
  const tool = codeTool([
    defineTool({name:"page.perceive",description:"Observe",parameters:z.object({}),execute:async()=>({ok:true,value:{text:"ready",elements:[]}})}),
    defineTool({name:"page.type",description:"Write",parameters:z.object({text:z.string()}),execute:writes}),
    defineTool({name:"page.verify",description:"Verify",parameters:z.object({}),execute:async()=>({ok:true,value:{verified:true}})}),
    defineTool({name:"done",description:"Finish",parameters:z.object({result:z.unknown().optional()}),execute:async({result})=>({ok:true,value:result})}),
  ],{compiled,trace,progress,input:{body:"new record"}});
  return {tool,entries,trace,progress,writes};
}

it("exposes Python and screenshots and documents the underlying typed SDK",()=>{
  const tools=buildBrowserCodeTools({session:pythonFixture().session,pythonRunner:testRunner(),emit:async()=>({outcome:"deduped"})});
  expect(tools.map(t=>t.name)).toEqual(["browser.python", "browser.screenshot"]);
  expect(tools[0]!.description).toContain("page");
  expect(tools[0]!.description).toContain("browser.done(");
  expect(tools[0]!.description).toContain("playwright.sync_api");
});

it("exposes network history and CAPTCHA as separate browser tools", () => {
  const session = pythonFixture().session;
  session.network = { list: async () => ({ records: [], total: 0 }) } as unknown as typeof session.network;
  const tools = buildBrowserCodeTools({ session, pythonRunner: testRunner(), captcha: {} as CaptchaService,
    emit: async () => ({ outcome: "deduped" }) });
  expect(tools.map(tool => tool.name)).toEqual(["browser.python", "browser.screenshot", "browser.network", "browser.captcha"]);
});

it("uses structured input and journals operations before writes, stopping at terminal completion",async()=>{
  const f=fixture();
  const result=await f.tool.execute({source:`export default async function(api) {
    const page=await api.page.perceive({});
    if (!page.ok) throw new Error(page.error);
    await api.page.type({text:api.input.body});
    await api.page.verify({});
    try { await api.run.done({result:'saved'}); } catch {}
    await api.page.type({text:'MUST NOT EXECUTE'});
  }`});
  expect(result).toMatchObject({ok:true,terminal:{outcome:"done",result:"saved"}});
  expect(f.writes).toHaveBeenCalledTimes(1);
  expect(f.writes.mock.calls[0]![0]).toEqual({text:"new record"});
  expect(f.trace.flush).toHaveBeenCalled();
  const evidence=readSdkEvidence({runId:"r",entries:f.entries});
  expect(evidence.operations.map(o=>o.name)).toEqual(["page.perceive","page.type","page.verify","done"]);
  expect(evidence.input).toEqual({body:"new record"});
});

it("requires reconciliation of an interrupted write in static mode",async()=>{
  const f=fixture(true);
  await f.progress.set({inFlight:{tool:"page.type",operationId:"uncertain"}});
  const result=await f.tool.execute({source:`export default async function(api) {
    const blocked=await api.page.type({text:'blocked'});
    const read=await api.page.perceive({});
    await api.page.verify({});
    const write=await api.page.type({text:'reconciled'});
    return {blocked:blocked.code,read:read.ok,write:write.ok};
  }`});
  expect(result).toMatchObject({ok:true,value:{blocked:"reconciliation_required",read:true,write:false}});
  expect(f.writes).not.toHaveBeenCalled();
  expect(f.entries.some(e=>e.payload.phase === "finished" && (e.payload.result as {code?:string})?.code === "reconciliation_required")).toBe(true);
});

it("returns screenshots as image attachments and does not put image bytes into operation evidence",async()=>{
  const f=fixture();
  const tool=codeTool([defineTool({name:"page.screenshot",description:"image",parameters:z.object({}),execute:async()=>({ok:true,value:{image:true},images:[{mime:"image/png",data:"private-image-bytes"}]})})],{trace:f.trace});
  expect(await tool.execute({source:"export default async api => { await api.page.screenshot({}); return 'inspect'; }"}))
    .toMatchObject({ok:true,images:[{mime:"image/png",data:"private-image-bytes"}]});
  expect(JSON.stringify(f.entries)).not.toContain("private-image-bytes");
});

it("pins helper code for an invocation and executes it through the tracked SDK",async()=>{
  const f=fixture();
  const revisions=[{name:"write",revision:"v1",source:"export default async (api,args) => api.page.type({text:args.text})"}];
  const list=vi.fn(async()=>[...revisions]);
  const tool=codeTool([defineTool({name:"page.type",description:"write",parameters:z.object({text:z.string()}),execute:f.writes})],{
    trace:f.trace,helpers:{list,define:async(name,source)=>{const h={name,source,revision:"v2"};revisions.splice(0,1,h);return h;}},
  });
  await tool.execute({source:`export default async api => {
    await api.helpers.define({name:'write',source:'export default async (api,args) => api.page.type({text:"new:"+args.text})'});
    await api.helpers.call('write',{text:'one'});
  }`});
  await tool.execute({source:"export default async api => api.helpers.call('write',{text:'two'})"});
  expect(f.writes.mock.calls.map(c=>c[0])).toEqual([{text:"one"},{text:"new:two"}]);
  expect(f.entries.filter(e=>e.payload.name==="helpers.use"&&e.payload.phase==="started").map(e=>e.payload.args)).toEqual([{name:"write",revision:"v1"},{name:"write",revision:"v2"}]);
});

it("omits network evidence and source when network storage is disabled",async()=>{
  const f=fixture();
  const tool=codeTool([defineTool({name:"network.read",description:"read",parameters:z.object({}),execute:async()=>({ok:true,value:{body:"private-response"}})})],{trace:f.trace,storageFlags:{network:false}});
  expect(await tool.execute({source:"export default async api => api.network.read({})"})).toMatchObject({ok:true,value:{ok:true,value:{body:"private-response"}}});
  expect(JSON.stringify(f.entries)).not.toContain("private-response");
  expect(f.entries.find(e=>e.payload.action==="sdk.invocation")?.payload).toMatchObject({evidenceOmitted:true,source:undefined});
  expect(()=>readSdkEvidence({runId:"r",entries:f.entries})).toThrow("Incomplete");
});

it("preserves a bounded observation and write receipt when the summary is oversized", async () => {
  const f = fixture();
  const observation = { pageId: "p1", url: "https://fixture.test/" + "x".repeat(4000), title: "Saved",
    text: "saved record " + "\u0000".repeat(4000), elements: Array.from({ length: 80 }, (_, i) => ({
      anchor: `snapshot:e${i}`, role: "button", name: '"'.repeat(500), bounds: { x: 1, y: 2 },
    })) };
  const write = vi.fn(async () => ({ ok: true as const, value: observation }));
  const tool = codeTool([defineTool({name:"page.type",description:"write",parameters:z.object({}),execute:write})],
    { trace: f.trace, progress: f.progress });
  const result = await tool.execute({source:"export default async api => api.page.type({})"});
  expect(result).toMatchObject({ ok: false, code: "output_too_large", value: {
    limitChars: 8000, calls: 1, lastOperation: {tool:"page.type",ok:true},
    observation: {partial:true,pageId:"p1",title:"Saved"},
  } });
  expect(JSON.stringify(result).length).toBeLessThan(8000);
  expect(JSON.stringify(result)).not.toContain('"bounds"');
  expect(write).toHaveBeenCalledTimes(1);
  expect(await f.progress.get()).toMatchObject({inFlight:null,requiresReconciliation:false});
  expect(f.entries.find(e=>e.payload.action==="sdk.invocation")?.payload).toMatchObject({code:"output_too_large"});
});

it("allows switching back to the destination to reconcile an uncertain popup action", async () => {
  const f = fixture();
  const switchTab = vi.fn(async () => ({ok:true as const,value:{text:"Destination",elements:[]}}));
  const tool = codeTool([
    defineTool({name:"page.perceive",description:"observe",parameters:z.object({}),execute:async()=>{
      throw new AppError("browser_page_closed", "Popup closed; list tabs", {details:{outcomeUncertain:true}});
    }}),
    defineTool({name:"tabs.switch",description:"switch",parameters:z.object({id:z.string()}),execute:switchTab}),
    defineTool({name:"page.type",description:"write",parameters:z.object({text:z.string()}),execute:f.writes}),
  ], {compiled:true,progress:f.progress});
  await f.progress.set({requiresReconciliation:true,uncertainOperation:{tool:"page.click",operationId:"login"}});
  expect(await tool.execute({source:"export default async api => api.page.perceive({})"}))
    .toMatchObject({ok:true,value:{ok:false,code:"browser_page_closed"}});
  expect(await tool.execute({source:"export default async api => api.tabs.switch({id:'p1'})"}))
    .toMatchObject({ok:true,value:{ok:true}});
  expect(await f.progress.get()).toMatchObject({requiresReconciliation:true,uncertainOperation:{operationId:"login"}});
  expect(await tool.execute({source:"export default async api => api.page.type({text:'do not replay'})"}))
    .toMatchObject({ok:true,value:{ok:false,code:"reconciliation_required"}});
  expect(switchTab).toHaveBeenCalledTimes(1);
  expect(f.writes).not.toHaveBeenCalled();
});

it("continues the agent loop after a popup closes and verifies login on the surviving destination", async () => {
  const f = fixture();
  const destination = {id:"p1",url:()=>"https://destination.test/database",perceive:async()=>({
    url:"https://destination.test/database",title:"Database",text:"Database ready",elements:[],
  })};
  const tabs = vi.fn(async()=>[{id:"p1",url:destination.url(),title:"Database"}]);
  const switchTab = vi.fn(async()=>destination);
  const session = {page:{id:"p2",waitForLoadState:async()=>{throw new AppError("browser_timeout","Load timed out");},
    perceive:async()=>{throw new AppError("browser_page_closed","Popup closed");},tabs,switchTab},
    resolveAnchor:()=>undefined} as unknown as RunSession;
  const sources = [
    "export default async api => api.page.waitForLoadState({state:'load'})",
    "export default async api => api.tabs.list({})",
    "export default async api => { const p=await api.tabs.switch({id:'p1'}); return {ok:p.ok}; }",
    "export default async api => { const p=await api.page.perceive({}); if(!p.ok || !p.value.text.includes('Database ready')) throw new Error('Destination not ready'); await api.run.done({result:'verified'}); }",
  ];
  let turn = 0;
  const result = await runAgentLoop({
    llm:{complete:async()=>{
      const source = sources[turn++];
      if (!source) throw new Error("Agent did not finish after recovery");
      return {toolCalls:[{id:String(turn),name:"browser.code",args:{source}}],usage:{in:1,out:1}};
    }},
    tools:[codeTool(buildToolRegistry({session,trace:f.trace,emit:async()=>({outcome:"deduped"})}),{trace:f.trace})],
    task:{prompt:"Verify destination login"},trigger:null,emits:[],trace:f.trace,
  });
  expect(result).toMatchObject({outcome:"done",result:"verified"});
  expect(tabs).toHaveBeenCalledTimes(1);
  expect(switchTab).toHaveBeenCalledTimes(1);
  expect(session.page).toBe(destination);
});
