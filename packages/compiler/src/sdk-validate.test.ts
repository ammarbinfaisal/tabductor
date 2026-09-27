import { expect, it } from "vitest";
import { validateSdkCandidate } from "./sdk-validate.js";
import { checkSdkPlan, isPlannedDeopt, readSdkEvidence, type SdkEvidence, type SdkPlan } from "./sdk-evidence.js";

const observation={ok:true,value:{elements:[{anchor:"snapshot:old",role:"textbox",name:"Body"}]}};
const evidence: SdkEvidence = {input:{body:"original tweet",id:"original-id"},invocations:[],helpers:[],
  api:["page.perceive","page.type","page.verify","record.outcome","done","run.deopt"].map(name=>({name,parameters:{}})),
  operations:[
    {name:"page.perceive",effect:false,args:{},result:observation},
    {name:"page.type",effect:true,args:{anchor:"snapshot:old",text:"original tweet"},result:{ok:true,value:{}}},
    {name:"page.verify",effect:false,args:{recordKey:"original-id"},result:{ok:true,value:{verified:true}}},
    {name:"record.outcome",effect:true,args:{status:"saved",reason:"Verified committed record"},result:{ok:true,value:{recorded:"saved"}}},
    {name:"done",effect:true,args:{},result:{ok:true,value:null}},
  ].map((op,i)=>({...op,operationId:`op${i}`,invocationId:"invocation",sequence:i})),
};
const plan: SdkPlan = {goal:"save",guards:[{operationId:"op0",condition:"editable body present"}],
  steps:evidence.operations.slice(1).map(o=>({operationId:o.operationId,why:"required work"})),
  bindings:[{source:"api.input.body",use:"typed content"}],discarded:[],recoveryPrompt:"Reconcile and resume"};
const source=`export default async function(api) {
  const p=await api.page.perceive({});
  if(!p.ok || !p.value.elements.length) return api.run.deopt({reason:'Editor changed'});
  const typed=await api.page.type({anchor:p.value.elements[0].anchor,text:api.input.body});
  if(!typed.ok) return api.run.deopt({reason:typed.error});
  const verified=await api.page.verify({recordKey:api.input.id});
  if(!verified.ok) return api.run.deopt({reason:verified.error});
  const recorded=await api.record.outcome({status:'saved',reason:'Verified committed record'});
  if(!recorded.ok) return api.run.deopt({reason:recorded.error});
  return api.run.done({});
}`;

it("validates a guarded writer on fresh values and ephemeral anchors without a browser",async()=>{
  expect(checkSdkPlan(plan,evidence)).toBeUndefined();
  expect(await validateSdkCandidate(source,evidence,plan)).toEqual({ok:true});
});
it("accepts completion without a dedicated verification operation",async()=>{
  const operations=evidence.operations.filter(o=>o.name!=="page.verify");
  const withoutProof={...plan,steps:plan.steps.filter(s=>s.operationId!=="op2")};
  const candidate=source.split("\n").filter(line=>!line.includes("const verified=")&&!line.includes("if(!verified.ok)")).join("\n");
  expect(await validateSdkCandidate(candidate,{...evidence,operations},withoutProof)).toEqual({ok:true});
});
it("rejects copied sample data and historical anchors",async()=>{
  for (const bad of [source.replace("api.input.body",JSON.stringify("original tweet")),source.replace("p.value.elements[0].anchor",JSON.stringify("snapshot:old"))])
    expect(await validateSdkCandidate(bad,evidence,plan)).toMatchObject({ok:false,reason:expect.stringContaining("sample-bound")});
});
it("rejects missing work, invented operations and ineffective guards",async()=>{
  expect(checkSdkPlan({...plan,steps:plan.steps.slice(1)},evidence)).toContain("Every successful");
  expect(checkSdkPlan({...plan,steps:[...plan.steps,{operationId:"invented",why:"why"}]},evidence)).toContain("unobserved");
  expect(await validateSdkCandidate(source.replace("if(!p.ok || !p.value.elements.length)","if(false)"),evidence,plan)).toMatchObject({ok:false});
  expect(await validateSdkCandidate(source.replace("await api.record.outcome({status:'saved',reason:'Verified committed record'});",""),evidence,plan)).toMatchObject({ok:false});
});
it("refuses missing operation outcomes and redacted source evidence",()=>{
  expect(()=>readSdkEvidence({runId:"r",entries:[{seq:0,kind:"action",payload:{action:"sdk.invocation",evidenceOmitted:true}}]})).toThrow("Incomplete");
});
it("refuses traces from an unknown operation schema version",()=>{
  expect(()=>readSdkEvidence({runId:"r",entries:[{seq:0,kind:"action",payload:{action:"sdk.invocation",operationVersion:99}}]})).toThrow("Unsupported SDK operation version");
});

it("keeps Python helper revision changes as provenance for primitive compilation",()=>{
  const entries: Array<{seq:number;kind:string;payload:Record<string,unknown>}>=[];
  const push=(payload:Record<string,unknown>)=>entries.push({seq:entries.length,kind:"action",payload});
  for(const revision of ["v1","v2"]){
    push({action:"sdk.invocation",invocationId:revision,language:"python",operationVersion:2,input:{},source:"helper()",api:[],helpers:[{name:"helper",revision,source:"def helper(): pass"}]});
    push({action:"sdk.operation",phase:"started",invocationId:revision,operationId:revision,sequence:entries.length,name:"helpers.use",args:{name:"helper",revision}});
    push({action:"sdk.operation",phase:"finished",operationId:revision,result:{ok:true,value:{name:"helper",revision}}});
  }
  push({action:"sdk.operation",phase:"started",invocationId:"v2",operationId:"done",sequence:entries.length,name:"done",args:{}});
  push({action:"sdk.operation",phase:"finished",operationId:"done",result:{ok:true,value:null}});
  const evidence=readSdkEvidence({runId:"revisions",entries});
  expect(evidence.helpers).toEqual([]);
  expect(evidence.invocations.map(i=>(i.helpers as Array<{revision:string}>)[0]!.revision)).toEqual(["v1","v2"]);
});

it("rejects retrying an uncertain effect after a committed prefix",async()=>{
  const unsafe=source.replace("if(!typed.ok) return api.run.deopt({reason:typed.error});", "if(!typed.ok) await api.page.type({anchor:p.value.elements[0].anchor,text:api.input.body});");
  expect(await validateSdkCandidate(unsafe,evidence,plan)).toMatchObject({ok:false,reason:expect.stringContaining("uncertain")});
});

it("rejects guards that check only success rather than observed targets",async()=>{
  expect(await validateSdkCandidate(source.replace("!p.ok || !p.value.elements.length", "!p.ok"),evidence,plan)).toMatchObject({ok:false});
});

it("keeps irreducibly dynamic work as a grounded terminal AI suffix",async()=>{
  const hybrid: SdkPlan = {...plan,
    steps:[{operationId:"op1",why:"reusable deterministic prefix"}],
    deopts:[{id:"semantic-finish",operationIds:["op2","op3","op4"],
      prompt:"Inspect the current result, verify it, record the outcome, and finish the task.",
      why:"Whether the result is semantically correct requires runtime judgment"}]};
  expect(checkSdkPlan(hybrid,evidence)).toBeUndefined();
  expect(isPlannedDeopt(hybrid,{plannedDeopt:"semantic-finish"})).toBe(true);
  expect(isPlannedDeopt(hybrid,{plannedDeopt:"other"})).toBe(false);
  const hybridSource=`export default async function(api) {
    const p=await api.page.perceive({});
    if(!p.ok || !p.value.elements.length) return api.run.deopt({reason:'Editor changed'});
    const typed=await api.page.type({anchor:p.value.elements[0].anchor,text:api.input.body});
    if(!typed.ok) return api.run.deopt({reason:typed.error});
    return api.run.deopt({reason:'Inspect the current result, verify it, record the outcome, and finish the task.',evidence:{plannedDeopt:'semantic-finish'}});
  }`;
  expect(await validateSdkCandidate(hybridSource,evidence,hybrid)).toEqual({ok:true});
  expect((await validateSdkCandidate(hybridSource.replace("semantic-finish","wrong-marker"),evidence,hybrid)).ok).toBe(false);

  expect(checkSdkPlan({...hybrid,
    steps:[...hybrid.steps,{operationId:"op3",why:"cannot run after handoff"}],
    deopts:[{...hybrid.deopts![0]!,operationIds:["op2","op4"]}]},evidence))
    .toContain("terminal suffix");
  expect(checkSdkPlan({...hybrid,deopts:[{...hybrid.deopts![0]!,operationIds:["op2","op3"]}]},evidence))
    .toContain("dropped verified work");
});

it("retains store effects and requires guards on current query results", () => {
  const operations = [
    { name: "workflow.store.query", effect: false, args: { sql: "select id from items" }, result: { ok: true, value: { rows: [{ id: "a" }], truncated: false } } },
    { name: "workflow.store.upsert", effect: true, args: { table: "items", row: { id: "a" }, idempotencyKey: "a" }, result: { ok: true, value: { committed: true } } },
    { name: "workflow.done", effect: true, args: {}, result: { ok: true, value: null } },
  ].map((operation, sequence) => ({ ...operation, operationId: `store${sequence}`, invocationId: "cell", sequence }));
  const observed: SdkEvidence = { input: {}, operations, invocations: [], helpers: [], api: [] };
  const guarded: SdkPlan = { goal: "Save records", guards: [{ operationId: "store0", condition: "Complete rows with stable IDs" }],
    steps: [{ operationId: "store1", why: "Save row" }, { operationId: "store2", why: "Finish" }], bindings: [], discarded: [], recoveryPrompt: "Inspect changed records" };
  expect(checkSdkPlan(guarded, observed)).toBeUndefined();
  expect(checkSdkPlan({ ...guarded, steps: guarded.steps.slice(1), discarded: [{ operationId: "store1", why: "Skip" }] }, observed)).toMatch(/dropped/);
  expect(checkSdkPlan({ ...guarded, guards: [], steps: [{ operationId: "store0", why: "Read" }, ...guarded.steps] }, observed)).toMatch(/Store queries/);
});
