import { expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError } from "@tabductor/core";
import type { AnchoredElement, Perception, RunSession } from "@tabductor/browser";
import { actionTarget, boundActionHistory, observeAfterAction, readActionHistory, withActionSummaries, type BrowserActionSummary } from "./browser-actions.js";
import { buildToolRegistry, summarizePerception, type ToolResult } from "./tools.js";
import { runAgentLoop } from "./loop.js";
import { toModelMessages } from "./llm-live.js";

const trace = { record: vi.fn(async () => {}), flush: async () => {}, close: async () => {} };
const store = (initial: unknown = []) => {
  let value = initial;
  return { get: async () => value, set: async (v: unknown) => { value = structuredClone(v); } };
};
const perception = (extra: Partial<Perception> = {}): Perception => ({
  url: "https://fixture.test/?private=query", title: "Page", text: "", elements: [],
  activeScope: "page", uiFingerprint: "initial", focusIdentity: "", ...extra,
});
const summary = (id = "one"): BrowserActionSummary => ({ id, tool: "page.click", target: { role: "button", name: "Add property" }, dispatch: "executed", changes: ["dialog_opened"] });

it("waits for delayed dialog controls and returns only final snapshot anchors", async () => {
  const start = Date.now();
  let reads = 0;
  const session = { page: { perceive: async () => {
    reads++;
    return perception({ snapshotId: String(reads), activeScope: "dialog", uiFingerprint: Date.now() - start >= 180 ? "editor" : "empty-dialog" });
  } } } as unknown as RunSession;
  const result = await observeAfterAction(session, { summarize: summarizePerception });
  expect(result).toMatchObject({ ok: true, observation: { stability: "settled", activeScope: "dialog" } });
  expect((result.value as {snapshotId: string}).snapshotId).toBe(String(reads));
  expect(Date.now() - start).toBeGreaterThanOrEqual(480);
});

it("bounds an unstable UI and respects the remaining session budget", async () => {
  let reads = 0;
  const session = { remainingWallMs: () => 200, page: { perceive: async () => perception({ uiFingerprint: String(++reads) }) } } as unknown as RunSession;
  const result = await observeAfterAction(session, { summarize: summarizePerception });
  expect(result).toMatchObject({ ok: true, observation: { stability: "unsettled" }, recovery: { suggestedTools: ["page.perceive", "page.waitFor"] } });
  expect(result.observation!.durationMs).toBeLessThan(600);
});

it("does not turn an executed click into failure when readback fails", async () => {
  const click = vi.fn(async () => {});
  const actions = store();
  const session = { resolveAnchor: () => "button", page: { click, perceive: async () => { throw new Error("readback failed"); } } } as unknown as RunSession;
  const tools = new Map(buildToolRegistry({ session, actions, emit: async () => ({ outcome: "deduped" }) }).map(t => [t.name, t]));
  const result = await tools.get("page.click")!.execute({ anchor: "e1" });
  expect(result).toMatchObject({ ok: true, value: null, action: { dispatch: "executed", changes: ["change_unknown"] }, observation: { stability: "unavailable" } });
  expect(click).toHaveBeenCalledTimes(1);
});

it("propagates cancellation and takeover rather than describing them as successful readback", async () => {
  const controller = new AbortController();
  const session = { page: { perceive: async () => perception() } } as unknown as RunSession;
  controller.abort();
  await expect(observeAfterAction(session, { summarize: summarizePerception, signal: controller.signal })).rejects.toThrow();
  await expect(observeAfterAction(session, { summarize: summarizePerception, beforeCall: async () => ({ fresh: true }) })).rejects.toMatchObject({ code: "browser_fresh_perception_required" });
  session.page.perceive = async () => { throw new AppError("run_lease_lost", "lost"); };
  await expect(observeAfterAction(session, { summarize: summarizePerception })).rejects.toMatchObject({ code: "run_lease_lost" });
});

it("preserves an executed login click and directs recovery to surviving tabs when the popup closes", async () => {
  const click = vi.fn(async () => {});
  const session = {resolveAnchor:()=>"button",page:{click,perceive:async()=>{
    throw new AppError("browser_page_closed", "Popup closed");
  }}} as unknown as RunSession;
  const tools = new Map(buildToolRegistry({session,emit:async()=>({outcome:"deduped"})}).map(t=>[t.name,t]));
  expect(await tools.get("page.click")!.execute({anchor:"e1"})).toMatchObject({
    ok:true,action:{dispatch:"executed"},observation:{stability:"unavailable"},
    recovery:{reason:"page_closed",suggestedTools:["tabs.list","tabs.switch"]},
  });
  expect(click).toHaveBeenCalledTimes(1);
});

it("exposes popup closure discovered while recovering a timed-out load wait", async () => {
  const session = {page:{waitForLoadState:async()=>{throw new AppError("browser_timeout","Load timed out");},
    perceive:async()=>{throw new AppError("browser_page_closed","Popup closed");}}} as unknown as RunSession;
  const tools = new Map(buildToolRegistry({session,emit:async()=>({outcome:"deduped"})}).map(t=>[t.name,t]));
  expect(await tools.get("page.waitForLoadState")!.execute({state:"load"})).toMatchObject({
    ok:false,code:"browser_page_closed",error:expect.stringContaining("tabs.list"),
    recovery:{reason:"page_closed"},
  });
});

it("captures labels before dispatch without retaining entered values, anchors or URL queries", async () => {
  const actions = store();
  const target = { tag: "input", role: "textbox", name: "typed-secret", value: "typed-secret", controlLabel: "Property name", anchor: "expired", inputType: "text" } as AnchoredElement;
  const before = perception(); let current = before;
  const session = { anchorInfo: () => target, lastPerception: () => current } as unknown as RunSession;
  const wrapped = withActionSummaries({ name: "page.type", description: "", parameters: z.object({}), execute: async () => {
    current = perception({ activeScope: "dialog", uiFingerprint: "next", focusIdentity: "field", elements: [target] });
    return { ok: true, value: current };
  } }, { session, actions, trace });
  const result = await wrapped.execute({ anchor: "expired", text: "typed-secret" });
  expect(result.action).toMatchObject({ target: { name: "Property name" }, changes: ["dialog_opened", "focus_changed", "ui_changed"] });
  const persisted = JSON.stringify(await actions.get());
  for (const forbidden of ["typed-secret", "expired", "private=query"]) expect(persisted).not.toContain(forbidden);
  expect(actionTarget({ ...target, inputType: "password" })).toEqual({ role: "textbox" });
  expect(actionTarget({ ...target, controlLabel: undefined })).toEqual({ role: "textbox" });
  const recorded = JSON.stringify(trace.record.mock.calls);
  expect(recorded).not.toContain("Property name");
});

it.each([
  [{ok:false,error:"bad",code:"invalid_arguments"}, "rejected"],
  [{ok:false,error:"bad",code:"browser_stale_target",outcomeUncertain:false}, "rejected"],
  [{ok:false,error:"failed",outcomeUncertain:false}, "failed"],
  [{ok:false,error:"timeout",outcomeUncertain:true}, "uncertain"],
] as const)("keeps dispatch outcomes distinct: %j", async (result, dispatch) => {
  const tool = withActionSummaries({name:"page.click",description:"",parameters:z.object({}),execute:async()=>result}, {session:{} as RunSession,actions:store()});
  expect((await tool.execute({})).action?.dispatch).toBe(dispatch);
});

it("bounds history independently of model-written memory and accepts old empty state", async () => {
  const rows = Array.from({length: 100}, (_, i) => ({...summary(String(i)), controls: Array.from({length:4},()=>({role:"textbox",name:"x".repeat(120)}))}));
  const bounded = boundActionHistory(rows);
  expect(bounded.length).toBeLessThanOrEqual(20);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(12000);
  expect(bounded.at(-1)?.id).toBe("99");
  expect(readActionHistory(null)).toEqual([]);
  const actions = store([summary()]);
  const session = {page:{},resolveAnchor:()=>undefined} as unknown as RunSession;
  const tools = new Map(buildToolRegistry({session,actions,emit:async()=>({outcome:"deduped"})}).map(t=>[t.name,t]));
  await tools.get("memory.set")!.execute({facts:["new fact"],pending:[]});
  expect(await actions.get()).toEqual([summary()]);
  expect(await tools.get("memory.get")!.execute({})).toMatchObject({value:{actions:[summary()]}});
});

it.each([11000, 32000])("sends action summaries only through their tool results at budget %s", async (budget) => {
  const actions = store([summary("prior-run")]);
  let turn = 0;
  const observed: string[] = [];
  const tool = { name: "page.click", description: "", parameters: z.object({}), execute: async (): Promise<ToolResult> => {
    const action = summary(`step-${turn}`);
    await actions.set([...readActionHistory(await actions.get()), action]);
    return {ok:true,action,value:perception({text:"large observation ".repeat(1300)})};
  }};
  await runAgentLoop({llm:{complete:async req=>{
    observed.push(JSON.stringify(toModelMessages(req.messages)));
    expect(req.messages.every(message => !message.actionSummaries?.length)).toBe(true);
    turn++;
    return {toolCalls:[{id:String(turn),name:turn===6?"done":"page.click",args:budget===11000?{padding:"opaque ".repeat(1800)}:{}}],usage:{in:1,out:1}};
  }},tools:[tool,{name:"done",description:"",parameters:z.object({}),execute:async()=>({ok:true,value:null})}],
  task:{prompt:""},trigger:null,emits:[],trace,maxInputTokens:budget});
  expect(observed[0]).not.toContain("prior-run");
  expect(observed[1]).toContain("step-1");
  expect(observed[1]).toContain("Add property");
  expect(observed[1]!.split('\\"id\\":\\"step-1\\"').length - 1).toBe(1);
});

it("journals nested browser.code actions even if the script returns no action details", async () => {
  const actions = store();
  const p = perception();
  const session = {page:{click:async()=>{},perceive:async()=>p},resolveAnchor:()=>"button",lastPerception:()=>p} as unknown as RunSession;
  const tools = new Map(buildToolRegistry({session,actions,emit:async()=>({outcome:"deduped"})}).map(t=>[t.name,t]));
  const result = await tools.get("browser.code")!.execute({source:'export default async function(tools) { await tools.call("page.click", {anchor:"e1"}); return "finished"; }'});
  expect(result).toMatchObject({ok:true,value:"finished"});
  expect(readActionHistory(await actions.get())).toHaveLength(1);
  expect(readActionHistory(await actions.get())[0]).toMatchObject({tool:"page.click",dispatch:"executed"});
});

it("retains fresh takeover evidence and skips the remaining queued actions", async () => {
  let takeover = false, callbackReads = 0, modelCalls = 0, clicks = 0;
  const fresh = perception({text:"Human changed the browser",uiFingerprint:"human"});
  const beforeCall = async () => { callbackReads++; if (takeover) { takeover=false; return fresh; } return undefined; };
  const session = {page:{click:async()=>{clicks++;takeover=true;},perceive:async()=>fresh},resolveAnchor:()=>"button"} as unknown as RunSession;
  const actions=store();
  const registry=buildToolRegistry({session,actions,beforeCall,emit:async()=>({outcome:"deduped"})});
  let secondRequest="";
  await runAgentLoop({llm:{complete:async req=>{
    if(modelCalls++===0)return{toolCalls:[{id:"click1",name:"page.click",args:{anchor:"e1"}},{id:"click2",name:"page.click",args:{anchor:"e2"}}],usage:{in:1,out:1}};
    secondRequest=JSON.stringify(toModelMessages(req.messages));
    return{toolCalls:[{id:"end",name:"fail",args:{reason:"Test complete"}}],usage:{in:1,out:1}};
  }},tools:registry,beforeStep:beforeCall,task:{prompt:""},trigger:null,emits:[],trace});
  expect(clicks).toBe(1);
  expect(callbackReads).toBeGreaterThan(1);
  expect(secondRequest).toContain("Human changed the browser");
  expect(secondRequest).toContain("Call was not executed");
  expect(readActionHistory(await actions.get())[0]).toMatchObject({dispatch:"executed",changes:["change_unknown","browser_control_changed"]});
});

it("propagates terminal cycle failures from browser.code without an uncertain in-flight effect", async () => {
  const {codeTool}=await import("./code-tool.js");
  const progress=store({});
  const nested={name:"page.click",description:"",parameters:z.object({}),execute:async():Promise<ToolResult>=>{throw new AppError("agent_no_progress","cycle exhausted");}};
  const code=codeTool([nested],{progress});
  await expect(code.execute({source:'export default async function(tools) { await tools.call("page.click", {}); }'})).rejects.toMatchObject({code:"agent_no_progress"});
  expect(await progress.get()).toMatchObject({inFlight:null});
});

it("selects the current tab repeatedly without dispatch or no-progress failures", async () => {
  const actions = store();
  const switchTab = vi.fn();
  const session = {page:{id:"p2",switchTab,perceive:async()=>perception({text:"Choose an account"})}} as unknown as RunSession;
  const tools = new Map(buildToolRegistry({session,actions,emit:async()=>({outcome:"deduped"})}).map(t=>[t.name,t]));
  for (let i = 0; i < 8; i++) {
    expect(await tools.get("tabs.switch")!.execute({id:"p2"})).toMatchObject({ok:true,value:{text:"Choose an account"}});
  }
  expect(switchTab).not.toHaveBeenCalled();
  expect(await actions.get()).toEqual([]);
});
