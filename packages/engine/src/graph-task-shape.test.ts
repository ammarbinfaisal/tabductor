import { expect, it } from "vitest";
import { checkGraph, graphSchema, graphTaskSchema } from "./graph.js";
import { bindIntent } from "./intent-contract.js";
import { gateGraphDraft, llmGraphCompiler } from "./graph-authoring.js";

const request = "Collect tweets and save them to https://destination.test/database";
function draft() {
  const destination = {url:"https://destination.test/database",setupTask:"setup",readyEvent:"destination.ready",
    contractField:"destination_contract_id",identityField:"stable_identity",requiredFields:["body"]};
  const task = (name:string,role:string) => ({name,logicalId:name,entry:role==="prepare-destination",kind:"browser",mode:"ai",prompt:request,
    limits:{harness:{version:1,role,requirementIds:["save"],destination}}});
  return {graph:{automationPrompt:request,contractVersion:2,externalInputs:[],systemInputs:[],maxRuns:1000,
    intent:bindIntent(request,{requirements:[{id:"save",description:"Save tweets",quote:request,category:"destination"}]}),
    tasks:[
      {...task("setup","prepare-destination"),emits:["destination.ready"],consumes:[]},
      {...task("source","source"),limits:{...task("source","source").limits,consumes:["destination.ready"],emits:["record.ready"]}},
      {...task("writer","write-record"),emits:[],consumes:["record.ready"]},
    ],events:[{type:"destination.ready",description:"Destination contract reference"},{type:"record.ready",description:"Tweet and destination reference",
      record:{collection:"tweets",key:"stable_identity",status:"pending"}}]},store:null,proposedGrants:[]};
}

it("recovers misplaced source routes before defaults erase them, without mutating the draft",()=>{
  const raw=draft(), before=JSON.stringify(raw);
  const graph=graphSchema.parse(raw.graph);
  expect(()=>checkGraph(graph)).not.toThrow();
  expect(graph.tasks[1]).toMatchObject({entry:false,emits:["record.ready"],consumes:["destination.ready"]});
  expect(graph.tasks[1]!.limits).not.toHaveProperty("emits");
  expect(graph.tasks[1]!.limits).not.toHaveProperty("consumes");
  expect(JSON.stringify(raw)).toBe(before);
  expect(graphSchema.parse(graph)).toEqual(graph);
});

it("keeps explicit routing authoritative and rejects missing event producers",()=>{
  const raw=draft();
  Object.assign(raw.graph.tasks[1]!,{consumes:[],emits:[]});
  const graph=graphSchema.parse(raw.graph);
  expect(graph.tasks[1]).toMatchObject({consumes:[],emits:[]});
  expect(()=>checkGraph(graph)).toThrow('input "record.ready" is neither emitted');
});

it("validates lifted routes and places record processing next to the harness",()=>{
  expect(()=>graphTaskSchema.parse({name:"source",limits:{consumes:"destination.ready"}})).toThrow();
  const recordProcessing={version:1,eventType:"record.ready",identityField:"stable_identity",contentFields:["body"]};
  const task=graphTaskSchema.parse({name:"source",limits:{harness:{role:"source",recordProcessing}}});
  expect(task.limits.recordProcessing).toEqual(recordProcessing);
  expect(task.limits.harness).not.toHaveProperty("recordProcessing");
});

it("accepts recovered routing without imposing readiness gates",async()=>{
  const compiler=llmGraphCompiler({complete:async()=>({text:JSON.stringify(draft())})});
  expect(await compiler.compile({intent:request})).toMatchObject({ok:true,report:{attempts:1}});
  const broken=graphSchema.parse(draft().graph);
  broken.tasks[1]!.entry=true;
  delete broken.contractVersion;
  const gated=await gateGraphDraft({graph:broken,store:null,proposedGrants:[]});
  expect(gated.checks).toContainEqual(expect.objectContaining({check:"graph_shape",status:"pass"}));
  expect(broken.tasks.every(t => !("role" in (t.limits.harness as object)) && !("destination" in (t.limits.harness as object)))).toBe(true);
});
