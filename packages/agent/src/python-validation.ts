import { randomUUID } from "node:crypto";
import type { SdkEvidence, SdkPlan, RecordedOperation } from "../../compiler/src/sdk-evidence.js";
import type { PythonRunner } from "./python-runner.js";
import { createRunWorkspace, type WorkspaceFiles } from "./workspace.js";

const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"?v as Record<string,unknown>:{};
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const browserEffect=(op:RecordedOperation)=>op.effect&&!op.name.startsWith("internal.")&&!["workflow.done","workflow.fail","workflow.memory.set"].includes(op.name);

/** Candidates run in the ordinary networkless sandbox with a replay-only host. */
export async function validatePythonCandidate(runner:PythonRunner, source:string, evidence:SdkEvidence, plan:SdkPlan):Promise<{ok:true}|{ok:false;reason:string}> {
  if(!/^def run\(page, context, browser\):/m.test(source))return {ok:false,reason:"Define run(page, context, browser)"};
  const selected=new Set([...plan.guards,...plan.steps].map(x=>x.operationId));
  const plannedDeopt=plan.deopts?.[0];
  const callbackIds=new Map<string,string>();
  const callbackScopes=new Map(evidence.invocations.map(invocation=>[String(invocation.invocationId),String(invocation.replSessionId??invocation.invocationId)]));
  const callbackRef=(invocation:string,id:string)=>{
    const key=(callbackScopes.get(invocation)??invocation)+":"+id;
    if(!callbackIds.has(key))callbackIds.set(key,String(callbackIds.size+1));
    return callbackIds.get(key)!;
  };
  const remapCallbacks=(value:unknown,invocation:string):unknown=>{
    if(Array.isArray(value))return value.map(v=>remapCallbacks(v,invocation));
    if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,key==="$callback"?callbackRef(invocation,String(v)):remapCallbacks(v,invocation)]));
    return value;
  };
  const operations=evidence.operations.filter(op=>selected.has(op.operationId)).map(op=>({...op,args:remapCallbacks(op.args,op.invocationId) as Record<string,unknown>}));
  const guards=new Set(plan.guards.map(g=>g.operationId));
  const substitutions=new Map<string,string>();
  const numbers=new Map<number,number>();
  const suffix=randomUUID().slice(0,8);
  const collect=(value:unknown,path="input")=>{
    if(typeof value==="string"&&value)substitutions.set(value,/^https?:/.test(value)?`https://validation-${suffix}.invalid/${path}`:`changed-${suffix}-${path}`);
    else if(typeof value==="number")numbers.set(value,value+137);
    else if(Array.isArray(value))value.forEach((v,i)=>collect(v,`${path}.${i}`));
    else if(value&&typeof value==="object")for(const [k,v] of Object.entries(value))collect(v,`${path}.${k}`);
  };
  collect(evidence.input);
  for (const operation of operations) if (operation.name === "workflow.store.query" && operation.result.ok) collect(obj(operation.result.value).rows, "store");
  // An AI response is runtime data too. A retained AI call followed by a baked-in
  // sample answer must not pass replay. Leave constrained schema values alone.
  const collectAiResult = (value: unknown, schema: Record<string, unknown>, path: string) => {
    if (schema.const !== undefined || schema.enum || schema.anyOf || schema.oneOf || schema.allOf || schema.$ref) return;
    if (Array.isArray(value)) value.forEach((item, index) => collectAiResult(item, obj(schema.items), `${path}.${index}`));
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) collectAiResult(item, obj(obj(schema.properties)[key]), `${path}.${key}`);
    } else if (typeof value === "string" && !schema.pattern && !schema.format && schema.maxLength === undefined && schema.minLength === undefined) collect(value, path);
    else if (typeof value === "number" && ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].every(key => schema[key] === undefined)) collect(value, path);
  };
  for (const op of operations) if (op.name === "browser.ai") collectAiResult(op.result.value, obj(op.args.schema_def), "aiResult");
  for(const op of operations)if(op.name==="playwright.call"&&["evaluate","evaluate_all","json","all_text_contents"].includes(String(op.args.member)))collect(op.result.value,"observed");
  const references=(value:unknown)=>{
    if(!value||typeof value!=="object")return;
    const r=obj(obj(value).$ref);
    if(r.id)substitutions.set(String(r.id),`object-${suffix}-${substitutions.size}`);
    if(r.scope)substitutions.set(String(r.scope),`scope-${suffix}`);
    Object.values(value).forEach(references);
  };
  evidence.operations.forEach(op=>references(op.result));
  for(const op of evidence.operations.filter(op=>op.name==="playwright.open"))for(const key of ["page","context"]){
    const r=obj(obj(obj(op.result.value)[key]).$ref);if(r.id)substitutions.set(String(r.id),`${key}-${suffix}`);
  }
  const replace=(value:unknown):unknown=>{
    if(typeof value==="string"){
      if(substitutions.has(value))return substitutions.get(value)!;
      if(/^[\[{]/.test(value.trim())){try{return JSON.stringify(replace(JSON.parse(value)));}catch{/* ordinary text */}}
      for(const [a,b]of [...substitutions].sort(([a],[b])=>b.length-a.length))if(a.length>=4)value=(value as string).split(a).join(b);else value=(value as string).replace(new RegExp(`(?<![\\w])${a.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?![\\w])`,"g"),()=>b);
      return value;
    }
    if(typeof value==="number")return numbers.get(value)??value;
    if(Array.isArray(value))return value.map(replace);
    if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)]));
    return value;
  };
  const roots=evidence.operations.find(op=>op.name==="playwright.open"&&op.result.ok)?.result.value;
  const replayArgs = (op: RecordedOperation) => op.name === "browser.ai"
    ? { ...obj(replace(op.args)), schema_def: op.args.schema_def }
    : replace(op.args);
  if(!roots)return {ok:false,reason:"Missing Playwright root-object evidence"};
  const callbacks:Record<string,unknown>[]=(evidence.callbacks??[]).map(event=>({...event,...(event.callback?{callback:callbackRef(String(event.invocationId),String(event.callback))}:{})}));
  const replay=async(failedId?:string,faultValue?:unknown)=>{
    const seen=new Set<string>();let terminal="",violation="",broken=false,effects=0;
    let deoptId:unknown,deoptReason:unknown;
    const blobs=new Map<string,Buffer>();let state:unknown=null;
    const workspace=createRunWorkspace({put:async bytes=>{const id=randomUUID();blobs.set(id,bytes);return id;},get:async id=>blobs.get(id)!},{get:async()=>state,set:async v=>{state=v;}});
    await workspace.commit(replace(evidence.invocations[0]?.workspaceBefore??{}) as WorkspaceFiles);
    const execution=runner.open?.({runId:`validation-${randomUUID()}`,leaseGeneration:0})??runner;
    try{
      await execution(source,async(name,args,_signal,_wait,context)=>{
        if(name==="playwright.open")return {ok:true,value:replace(roots)};
        if(name==="playwright.close")return {ok:true,value:null};
        if(name==="workflow.deopt"){
          terminal="deopt";
          deoptReason=obj(args).reason;
          deoptId=obj(obj(args).evidence).plannedDeopt;
          return {ok:true,value:args};
        }
        if(name==="workflow.yield_control")return {ok:true,value:null};
        if(name.startsWith("internal.workspace.")){
          const tool=workspace.tools().find(t=>t.name===name.slice(9));return tool?tool.execute(args):{ok:false,error:"Unknown workspace operation"};
        }
        if(name==="internal.helpers.use")return {ok:true,value:args};
        if(terminal)return {ok:false,error:"Execution already ended"};
        const op=operations.find(op=>!seen.has(op.operationId)&&op.name===name&&canonical(replayArgs(op))===canonical(args));
        if(!op){violation=`Ungrounded, repeated or sample-bound operation: ${name}: ${canonical(args).slice(0,1500)}; next recorded: ${String(canonical(replace(operations.find(o=>!seen.has(o.operationId)&&o.name===name)?.args))).slice(0,1500)}`;return {ok:false,error:violation};}
        if(op.operationId===failedId){broken=true;return faultValue===undefined?{ok:false,error:"Recorded operation failed",outcomeUncertain:op.effect}:{ok:true,value:faultValue};}
        if(broken&&op.effect){violation="Effect after a failed guard or uncertain operation";return {ok:false,error:violation};}
        if(browserEffect(op)&&operations.some(prior=>browserEffect(prior)&&!seen.has(prior.operationId)&&operations.indexOf(prior)<operations.indexOf(op))){violation="Reordered browser effects";return {ok:false,error:violation};}
        seen.add(op.operationId);if(browserEffect(op))effects++;
        for(const event of callbacks.filter(e=>e.parentOperationId===op.operationId&&e.phase==="started")){
          const reply=await context!.requestCallback(replace(event));
          const recorded=callbacks.find(e=>e.id===event.id&&e.phase==="finished");
          if(!recorded||recorded.error||canonical(reply)!==canonical(replace(recorded.value))){violation="Callback result diverged from recorded data flow";return {ok:false,error:violation};}
        }
        if(name==="workflow.emit"||name==="workflow.emit.batch"){
          const items=name==="workflow.emit"?[obj(args)]:(obj(args).items??[]) as Record<string,unknown>[];
          if(items.some(item=>typeof item.dedupeKey!=="string"||!item.dedupeKey)){violation="Missing stable event dedupe key";return {ok:false,error:violation};}
        }
        if(name==="workflow.done")terminal="done";
        if(name==="workflow.fail")terminal="fail";
        return replace(op.result);
      },{compiled:true,input:replace(evidence.input),helpers:evidence.helpers,workspace,wallClockMs:3000,maxCalls:1000});
    }finally{await execution.close?.();}
    return {terminal,violation,broken,effects,seen,deoptId,deoptReason};
  };
  const normal=await replay();
  const retained=operations.filter(op=>op.result.ok&&!op.name.startsWith("internal.")&&!["playwright.open","playwright.close"].includes(op.name));
  const expectedTerminal=plannedDeopt?"deopt":"done";
  const plannedMismatch=plannedDeopt&&(normal.deoptId!==plannedDeopt.id||normal.deoptReason!==plannedDeopt.prompt);
  if(normal.violation||normal.terminal!==expectedTerminal||plannedMismatch||retained.some(op=>!normal.seen.has(op.operationId)))
    return {ok:false,reason:normal.violation||(plannedMismatch?"Candidate did not preserve the planned AI handoff":"Candidate did not preserve required work and finish on changed input")};
  for(const op of operations.filter(op=>guards.has(op.operationId)||browserEffect(op))){
    const failed=await replay(op.operationId);
    if(failed.terminal!=="deopt"||failed.violation||plannedDeopt&&failed.deoptId===plannedDeopt.id)
      return {ok:false,reason:`Candidate does not hand off failed ${op.name} without replaying effects`};
    if(!guards.has(op.operationId))continue;
    const value=replace(op.result.value), variants:unknown[]=[];
    if(Array.isArray(value)){
      variants.push([],value.slice(0,-1),[...value,value[0]]);
      if(value.length&&typeof value[0]==="object")for(const key of Object.keys(obj(value[0]))){const row={...obj(value[0])};delete row[key];variants.push([row,...value.slice(1)]);}
    }else if(op.name === "workflow.store.query" && Array.isArray(obj(value).rows)) {
      const rows = obj(value).rows as unknown[];
      variants.push({ ...obj(value), rows: [], truncated: false }, { ...obj(value), truncated: true });
      if (rows.length) for (const key of Object.keys(obj(rows[0]))) { const row = { ...obj(rows[0]) }; delete row[key]; variants.push({ ...obj(value), rows: [row, ...rows.slice(1)] }); }
    }else if(typeof value==="boolean")variants.push(!value);
    else if(typeof value==="string")variants.push("");
    else if(typeof value==="number")variants.push(0,value+1);
    for(const variant of variants){
      const changed=await replay(op.operationId,variant);
      if(changed.terminal!=="deopt"||changed.violation||plannedDeopt&&changed.deoptId===plannedDeopt.id)
        return {ok:false,reason:"Candidate failed to guard changed observation contents"};
    }
  }
  return {ok:true};
}
