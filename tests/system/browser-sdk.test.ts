import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { browserHelpers, tasks, traceEntries } from "@tabductor/db";
import { seedWorkflow } from "@tabductor/engine/testing";
import { compileTask, loadRunTraces, promoteTask, readSdkEvidence } from "@tabductor/compiler";
import { startAgentRig, type AgentRig } from "./agent-support.js";
import { eventsOfType, runsForTask, trigger, waitFor } from "./engine-support.js";

let rig: AgentRig | undefined;
afterEach(async()=>{await rig?.stop();rig=undefined;});

it("compiles a verified SDK writer, writes a different record without a model, and recovers after a layout change",async()=>{
  const saved = new Map<string,string>();
  const saves = new Map<string,number>();
  let changed = false;
  let delayedCommit = false;
  const server = createServer(async(req,res)=>{
    if(req.url==="/save") {
      let body="";for await(const chunk of req)body+=chunk;
      const row=JSON.parse(body) as {id:string;text:string};
      saved.set(row.id,row.text);saves.set(row.id,(saves.get(row.id)??0)+1);res.end("ok");return;
    }
    res.setHeader("Content-Type","text/html");
    res.end(`<main><h1>Records</h1><input aria-label="${changed?"Record content":"Body"}"><button>Save</button><article></article></main>
      <script>document.querySelector('button').onclick=async()=>{
        const text=document.querySelector('input').value;
        const id=new URLSearchParams(location.search).get('record');
        await fetch('/save',{method:'POST',body:JSON.stringify({id,text})});
        setTimeout(()=>{document.querySelector('article').textContent=id+' '+text;document.querySelector('article').dataset.committed='true'},${delayedCommit?1800:0});
      };</script>`);
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const program=(label:string)=>`export default async function(api) {
    let p=await api.page.goto({url:api.input.url});
    if(!p.ok) return api.run.deopt({reason:p.error});
    p=await api.page.perceive({});
    const field=p.ok && p.value.elements.find(e=>e.name===${JSON.stringify(label)});
    if(!field) return api.run.deopt({reason:'Body editor changed'});
    p=await api.page.type({anchor:field.anchor,text:api.input.body});
    if(!p.ok) return api.run.deopt({reason:p.error});
    const button=p.value.elements.find(e=>e.role==='button' && e.name==='Save');
    if(!button) return api.run.deopt({reason:'Save button changed'});
    p=await api.page.click({anchor:button.anchor});
    if(!p.ok) return api.run.deopt({reason:p.error});
    const verified=await api.page.verify({textIncludes:api.input.body});
    if(!verified.ok) return api.run.deopt({reason:verified.error});
    const emitted=await api.emit({type:'record.saved',packet:{id:api.input.id,body:api.input.body},dedupeKey:api.input.id});
    if(!emitted.ok) return api.run.deopt({reason:emitted.error});
    return api.run.done({});
  }`;
  let modelCalls=0;
  try {
    rig=await startAgentRig({compiled:{},llmFor:()=>({complete:async request=>{
      modelCalls++;
      expect(request.tools.map(t=>t.name)).toEqual(["browser.code"]);
      const recovery=`export default async function(api) {
        await api.page.waitFor({text:api.input.body,timeoutMs:10000});
        const verified=await api.page.verify({textIncludes:api.input.body});
        if(!verified.ok) throw new Error(verified.error);
        await api.emit({type:'record.saved',packet:{id:api.input.id,body:api.input.body},dedupeKey:api.input.id});
        return api.run.done({});
      }`;
      return {usage:{in:1,out:1},toolCalls:[{id:"code",name:"browser.code",args:{source:delayedCommit?recovery:program(changed?"Record content":"Body")}}]};
    }})});
    const wf=await seedWorkflow(rig.handle.db,{tasks:{Start:{},Write:{mode:"ai",prompt:"Write and verify this record",consumes:["write"],emits:["record.saved"],retry:{max:0}}}});
    const fire=async(id:string,body:string)=>{
      const event = await trigger(rig!,wf.taskIds.Start!,"write",{id,body,url:`${url}/?record=${id}`});
      return waitFor("SDK writer to settle",async()=>{
        const rows=await runsForTask(rig!,wf.taskIds.Write!);
        const row = rows.find(r=>r.triggerEventId===event.eventId);
        return row && ["succeeded","failed"].includes(row.status) ? row : false;
      },60000);
    };
    const first=await fire("one","first body");
    expect(first.status,first.error??"").toBe("succeeded");
    const traces=await loadRunTraces(rig.handle.db,[first.id]);
    const evidence=readSdkEvidence(traces[0]!);
    const plan={goal:"Write record",guards:evidence.operations.filter(o=>o.name==="page.perceive").map(o=>({operationId:o.operationId,condition:"Body editor exists"})),
      steps:evidence.operations.filter(o=>o.name!=="page.perceive").map(o=>({operationId:o.operationId,why:"required"})),bindings:[{source:"api.input",use:"record fields"}],checkpoints:[],discarded:[],recoveryPrompt:"Inspect changed editor"};
    let compileTurn=0;
    const compiled=await compileTask({db:rig.handle.db,llm:{complete:async()=>({text:compileTurn++===0?JSON.stringify(plan):program("Body")})}},{taskId:wf.taskIds.Write!,sourceRunId:first.id,traces});
    expect(compiled.ok,compiled.ok?"":compiled.error).toBe(true);
    if(!compiled.ok) return;
    const [task]=await rig.handle.db.select().from(tasks).where(eq(tasks.id,wf.taskIds.Write!));
    expect((await promoteTask({db:rig.handle.db},{taskId:task!.id,scriptId:compiled.script.id,expectContentHash:task!.contentHash})).promoted).toBe(true);
    const calls=modelCalls;
    const second=await fire("two","second body");
    expect(second.status,second.error??"").toBe("succeeded");
    expect(modelCalls).toBe(calls);
    expect(saved.get("two")).toBe("second body");
    changed=true;
    const third=await fire("three","third body");
    expect(third.status,third.error??"").toBe("succeeded");
    expect(modelCalls).toBeGreaterThan(calls);
    expect(saved).toEqual(new Map([["one","first body"],["two","second body"],["three","third body"]]));
    const trace=await rig.handle.db.select().from(traceEntries).where(and(eq(traceEntries.runId,third.id),eq(traceEntries.kind,"action")));
    expect(trace.some(e=>e.payloadJson && (e.payloadJson as {action:string}).action==="deopt")).toBe(true);
    expect(await eventsOfType(rig,"record.saved")).toHaveLength(3);
    changed=false;delayedCommit=true;
    const fourth=await fire("four","body committed before recovery");
    expect(fourth.status,fourth.error??"").toBe("succeeded");
    expect(fourth.modeUsed).toBe("compiled");
    expect(saved.get("four")).toBe("body committed before recovery");
    expect(saves.get("four")).toBe(1);
    expect(await eventsOfType(rig,"record.saved")).toHaveLength(4);
    expect(await rig.handle.db.select().from(browserHelpers)).toEqual([]);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
},180000);
