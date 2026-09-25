import { expect, it } from "vitest";
import { z } from "zod";
import { runAgentLoop, compactHistory } from "./loop.js";
import { toModelMessages } from "./llm-live.js";
import { estimateModelInput } from "@tabductor/core";
import { buildToolRegistry, summarizePerception } from "./tools.js";
import type { RunSession } from "@tabductor/browser";
import type { LlmMessage } from "./llm.js";
const trace={record:async()=>{},flush:async()=>{},close:async()=>{}};

it("uses native tool call IDs and image content without serializing image bytes as text",()=>{
  const messages:LlmMessage[]=[{role:"assistant",content:"unused",toolCalls:[{id:"call1",name:"page.screenshot",args:{}}]},
    {role:"tool",content:"unused",toolResults:[{id:"call1",name:"page.screenshot",result:{ok:true,value:{bytes:100},images:[{data:"aGVsbG8=",mime:"image/png"}]}}]}];
  const wire=toModelMessages(messages);
  expect(wire[0]).toMatchObject({role:"assistant",content:[{type:"tool-call",toolCallId:"call1",toolName:"page__screenshot"}]});
  expect(wire[1]).toMatchObject({role:"tool",content:[{type:"tool-result",toolCallId:"call1",output:{type:"content",value:[{type:"text"},{type:"file",mediaType:"image/png"}]}}]});
  const image=estimateModelInput({messages:toModelMessages([{...messages[1]!,toolResults:[{id:"i",name:"page.screenshot",result:{ok:true,value:{},images:[{data:"a".repeat(100000),mime:"image/png"}]}}]}])});
  expect(image.requestBytes).toBeGreaterThan(100000);expect(image.inputTokenBound).toBeLessThan(12000);
});

it("keeps the assistant's recovery plan beside native tool calls", () => {
  const wire = toModelMessages([{ role: "assistant", content: "transcript copy", text: "The row already exists; fill its empty fields without creating another.",
    toolCalls: [{ id: "inspect", name: "browser.python", args: { source: "print(accessibility_tree('main')['tree'])" } }] }]);
  expect(wire[0]).toMatchObject({ role: "assistant", content: [
    { type: "text", text: expect.stringContaining("row already exists") }, { type: "tool-call", toolCallId: "inspect" },
  ] });
  expect(JSON.stringify(wire)).not.toContain("transcript copy");
});

it("returns native skipped outcomes for every call after a terminal action",async()=>{
  let saw:LlmMessage[]=[];let step=0;
  await runAgentLoop({llm:{complete:async req=>{saw=req.messages;return{usage:{in:1,out:1},toolCalls:step++===0?[{id:"bad",name:"page.fail",args:{}},{id:"skip",name:"write",args:{}}]:[{id:"end",name:"done",args:{}}]};}},
    tools:[{name:"page.fail",description:"fail",parameters:z.object({}),execute:async()=>({ok:false,error:"missing"})},
      {name:"write",description:"write",parameters:z.object({}),execute:async()=>{throw new Error("must not execute");}},
      {name:"done",description:"done",parameters:z.object({}),execute:async()=>({ok:true,value:null})}],task:{prompt:"test"},trigger:null,emits:[],trace});
  const result=saw.find(m=>m.role==="tool")!;
  expect(result.toolResults?.map(r=>r.id)).toEqual(["bad","skip"]);
  expect(result.toolResults?.[1]?.result).toMatchObject({ok:false,error:expect.stringContaining("not executed")});
});

it("compacts complete call/result pairs without synthesizing context",()=>{
  const messages:LlmMessage[]=[{role:"user",content:"Begin"}];
  for(let i=0;i<5;i++)messages.push({role:"assistant",content:"act"},{role:"tool",content:"bounded data ".repeat(1500)});
  compactHistory(messages);
  expect(messages[0]).toEqual({role:"user",content:"Begin"});
  expect(messages[1]!.role).toBe("assistant");expect(messages[2]!.role).toBe("tool");
  expect(messages).toHaveLength(5);
});

it("bounds dense observations with continuation instead of converting success to failure",()=>{
  const p={url:"https://example.test",title:"dense",text:"long text ".repeat(2000),elements:Array.from({length:100},(_,i)=>({anchor:`s1:e${i}`,tag:"button",role:"button",name:"long name ".repeat(20),text:"long text ".repeat(20),strategy:"css-path" as const,locator:`#${i}`}))};
  const summary=summarizePerception(p);
  expect(summary.text).toBe(p.text);expect(summary.nextElementOffset).not.toBeNull();expect(JSON.stringify(summary).length).toBeLessThan(30000);
});

it("retains exploration memory across registry recreation and detects repeated ineffective actions",async()=>{
  let state:unknown=null;const memory={get:async()=>state,set:async(v:unknown)=>{state=v;}};
  const page={click:async()=>{},perceive:async()=>({url:"https://fixture.test",title:"static",text:"unchanged",elements:[]})};
  const session={page,resolveAnchor:()=>"button"} as unknown as RunSession;
  const registry=()=>new Map(buildToolRegistry({session,compiled:true,memory,emit:async()=>({outcome:"deduped"})}).map(t=>[t.name,t]));
  const first=registry();await first.get("memory.set")!.execute({facts:["Panel is collapsed"],pending:["expand it"]});
  expect((await registry().get("memory.get")!.execute({})).value).toMatchObject({facts:["Panel is collapsed"]});
  for(let i=0;i<3;i++)expect(await first.get("page.click")!.execute({anchor:"e1"})).toMatchObject({ok:true});
  expect(await first.get("page.click")!.execute({anchor:"e1"})).toMatchObject({ok:false,error:expect.stringContaining("no observable change")});
});

it("paginates frame metadata within the observation budget while preserving requested text",()=>{
  const p={url:"https://example.test",title:"frames",text:"x".repeat(20000),elements:[],frameOffset:50,
    frames:Array.from({length:50},(_,i)=>({id:`f${50+i}`,url:"https://example.test/"+"x".repeat(280)})),nextFrameOffset:100};
  const summary=summarizePerception(p);
  expect(summary.text).toBe(p.text);
  expect(JSON.stringify(summary).length).toBeLessThan(28000);
  expect(summary.nextFrameOffset).toBe(50+(summary.frames as unknown[]).length);
  expect(summary.nextFrameOffset).toBeLessThan(100);
});

it("keeps a successful effect successful when its data is too large for history",async()=>{
  let turn=0;let result:unknown;
  await runAgentLoop({llm:{complete:async req=>{if(turn++===0)return{usage:{in:1,out:1},toolCalls:[{id:"write",name:"write",args:{}}]};
    result=req.messages.at(-1)!.toolResults?.[0]?.result;
    return{usage:{in:1,out:1},toolCalls:[{id:"done",name:"done",args:{}}]};}},
    tools:[{name:"write",description:"effect",parameters:z.object({}),execute:async()=>({ok:true,value:"result ".repeat(10000)})},
      {name:"done",description:"done",parameters:z.object({}),execute:async()=>({ok:true,value:null})}],task:{prompt:"act"},trigger:null,emits:[],trace});
  expect(result).toMatchObject({ok:true,value:{dataOmitted:true}});
});

it("blocks repeated failing targets across fresh snapshot names without disconnecting the run", async () => {
  let clicks = 0;
  const session = { page: { click: async () => { clicks++; throw new Error("target obstructed"); },
    perceive: async () => ({ url: "https://fixture.test", title: "", text: "unchanged", elements: [] }) },
    resolveAnchor: () => '[data-tabductor-node="stable"]' } as unknown as RunSession;
  const tools = new Map(buildToolRegistry({ session, compiled:true, emit: async () => ({ outcome: "deduped" }) }).map(t => [t.name, t]));
  for (const anchor of ["sabc-1:e1", "sabc-2:e3"]) expect(await tools.get("page.click")!.execute({ anchor })).toMatchObject({ ok: false });
  expect(await tools.get("page.click")!.execute({ anchor: "sabc-3:e9" })).toMatchObject({ ok: false, error: expect.stringContaining("failed twice") });
  expect(clicks).toBe(2);
});

it("records reported saves without a dedicated verification tool", async () => {
  let saved = 0;
  const tools = new Map(buildToolRegistry({ session: {} as RunSession, emit: async () => ({ outcome: "deduped" }), recordOutcome: async outcome => {
    expect(outcome).toEqual({ status: "saved", reason: "Saved" }); saved++;
  } }).map(t => [t.name, t]));
  expect(tools.has("page.verify")).toBe(false);
  expect(await tools.get("record.outcome")!.execute({ status: "saved", reason: "Saved" })).toMatchObject({ ok: true });
  expect(saved).toBe(1);
});
