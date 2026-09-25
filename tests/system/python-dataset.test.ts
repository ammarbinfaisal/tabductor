import { createServer } from "node:http";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tasks } from "@tabductor/db";
import { seedWorkflow } from "@tabductor/engine";
import { compileTask, loadRunTraces, promoteTask, readSdkEvidence } from "@tabductor/compiler";
import { createCamoufoxWorkerDriver } from "@tabductor/browser";
import { remotePythonRunner, validatePythonCandidate } from "@tabductor/agent";
import { AllowAllGate } from "@tabductor/policy";
import { startAgentRig, type AgentRig } from "./agent-support.js";
import { runsForTask, trigger, waitFor } from "./engine-support.js";

it.skipIf(!process.env.CAMOUFOX_TEST_URL || !process.env.PYTHON_RUNNER_TEST_URL)("learns file-backed 100-row browser requests and recovers a partial static write in Python AI mode",async()=>{
  const worker=process.env.CAMOUFOX_TEST_URL!, token=process.env.CAMOUFOX_TEST_TOKEN!, sessionId="dataset-fixture";
  const headers={authorization:`Bearer ${token}`,"content-type":"application/json","x-tabductor-rpc-version":"1"};
  const created=await fetch(`${worker}/v1/sessions`,{method:"POST",headers,body:JSON.stringify({session_id:sessionId,generation:1,profile_dir:sessionId})});
  expect(created.status,await created.text()).toBe(200);
  const saved=new Map<string,{id:string;text:string}>(), writes=new Map<string,number>();
  let partial=false, rig:AgentRig|undefined;
  const host=process.env.CAMOUFOX_FIXTURE_HOST ?? "127.0.0.1";
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,"http://fixture");
    if(url.pathname==="/save") {
      let body="";for await(const chunk of req)body+=chunk;
      const rows=JSON.parse(body).rows as Array<{id:string;text:string}>;
      const accepted=partial ? rows.slice(0,5) : rows;
      for(const row of accepted){saved.set(row.id,row);writes.set(row.id,(writes.get(row.id)??0)+1);}
      res.setHeader("Content-Type","application/json");res.statusCode=partial?500:200;
      partial=false;res.end(JSON.stringify({saved:accepted.length}));return;
    }
    if(url.pathname==="/rows") {
      res.setHeader("Content-Type","application/json");
      res.end(JSON.stringify([...saved.values()].filter(r=>r.id.startsWith(url.searchParams.get("batch")+"-"))));return;
    }
    const batch=url.searchParams.get("batch");
    const rows=Array.from({length:100},(_,i)=>({id:`${batch}-${i}`,text:`A \"quoted\" value ${i} — café`}));
    res.setHeader("Content-Type","text/html");res.end(`<h1>Dataset fixture</h1><input id="clipboard"><script>window.fixtureRows=${JSON.stringify(rows)}</script>`);
  });
  await new Promise<void>(resolve=>server.listen(0,host,resolve));
  const url=`http://${host}:${(server.address() as {port:number}).port}`;
  const extract="mw:() => window.fixtureRows";
  const readback="mw:async () => (await fetch('/rows'+location.search)).json()";
  const verify=`assert sorted(page.evaluate(${JSON.stringify(readback)}),key=lambda r:r['id']) == sorted(rows,key=lambda r:r['id'])\nworkflow.done()`;
  const extractSource=`import json\npage.goto(workflow.input['url'])\nrows=page.evaluate(${JSON.stringify(extract)})\nif len(rows)!=100 or any(not isinstance(r.get('id'),str) or not isinstance(r.get('text'),str) for r in rows) or len({r['id'] for r in rows})!=100: workflow.deopt(reason='Dataset shape changed')\nopen('rows.json','w').write(json.dumps(rows))`;
  const writeSource=`import json\nrows=json.load(open('rows.json'))\nresponse=context.request.post('/save',data={'rows':rows})\nif not response.ok: workflow.deopt(reason='Inspect partially committed rows before another write')\n${verify}`;
  const pythonRunner=remotePythonRunner(process.env.PYTHON_RUNNER_TEST_URL!,process.env.PYTHON_RUNNER_TEST_TOKEN!);
  let calls=0;
  try {
    rig=await startAgentRig({compiled:{},pythonRunner,
      gate:new AllowAllGate({navAllowlist:[host]}),chrome:{wsUrl:worker.replace(/^http/,"ws"),version:"camoufox",close:async()=>{}},
      driver:{connect:()=>createCamoufoxWorkerDriver({token,sessionId,generation:1}).connect(worker)},
      llmFor:()=>({complete:async request=>{
        calls++;
        const failed=request.messages.flatMap(m=>m.toolResults??[]).find(r=>!r.result.ok);
        if(failed || calls>3)throw new Error(`Unexpected Python fixture failure: ${JSON.stringify(failed?.result)}`);
        let source:string;
        if(calls===1) source=extractSource;
        else if(calls===2) source=writeSource;
        else source=`import json\nrows=json.load(open('rows.json'))\nactual=context.request.get('/rows?batch='+workflow.input['batch']).json()\nassert sorted(page.evaluate(${JSON.stringify(readback)}),key=lambda r:r['id']) == sorted(actual,key=lambda r:r['id'])\nseen={r['id'] for r in actual}\nmissing=[r for r in rows if r['id'] not in seen]\nassert len(missing)==95\ncontext.request.post('/save',data={'rows':missing})\n${verify}`;
        return {usage:{in:1,out:1},toolCalls:[{id:"python",name:"browser.python",args:{source}}]};
      }})});
    const wf=await seedWorkflow(rig.handle.db,{tasks:{Start:{},Save:{mode:"ai",prompt:"Copy all 100 rows and verify exact identity and text",consumes:["dataset"],retry:{max:0}}}});
    const fire=async(batch:string)=>{
      const event=await trigger(rig!,wf.taskIds.Start!,"dataset",{batch,url:`${url}/?batch=${batch}`});
      return waitFor("dataset run",async()=>{const r=(await runsForTask(rig!,wf.taskIds.Save!)).find(r=>r.triggerEventId===event.eventId);return r&&["succeeded","failed"].includes(r.status)?r:false;},60000).catch(async error=>{
        const runs=await runsForTask(rig!,wf.taskIds.Save!);
        const trace=await loadRunTraces(rig!.handle.db,runs.map(r=>r.id),rig!.blobs);
        throw new Error(`${error}; modelCalls=${calls}; recent=${JSON.stringify(trace.flatMap(t=>t.entries).filter(e=>e.payload.action==="sdk.operation"||e.payload.action==="sdk.invocation").slice(-8).map(e=>({name:e.payload.name,phase:e.payload.phase,outcome:e.payload.outcome,result:e.payload.result})))}`);
      });
    };
    const first=await fire("learn");expect(first.status,first.error??"").toBe("succeeded");
    const traces=await loadRunTraces(rig.handle.db,[first.id],rig.blobs), evidence=readSdkEvidence(traces[0]!);
    const kept=evidence.operations.filter(o=>!o.name.startsWith('internal.') && !['playwright.open','playwright.close'].includes(o.name));
    const guards=kept.filter(o=>o.name==='playwright.call' && o.args.member==='evaluate');
    const plan={goal:"Copy exact dataset",guards:guards.map(o=>({operationId:o.operationId,condition:"Expected destination and 100 records"})),
      steps:kept.filter(o=>!guards.includes(o)).map(o=>({operationId:o.operationId,why:"Required data flow"})),bindings:[],checkpoints:[],
      discarded:evidence.operations.filter(o=>!kept.includes(o)).map(o=>({operationId:o.operationId,why:"Transport bootstrap or workspace synchronization; preserve ordinary Python file data flow"})),recoveryPrompt:"Use Python and existing rows.json; read saved rows and write only missing identities"};
    const program="def run(page, context, workflow):\n    try:\n"+(extractSource+'\n'+writeSource).split('\n').map(line=>'        '+line).join('\n')+"\n    except Exception as error:\n        workflow.deopt(reason=str(error))";
    let turn=0;
    const compiled=await compileTask({db:rig.handle.db,validatePython:(source,evidence,plan)=>validatePythonCandidate(pythonRunner,source,evidence,plan),llm:{complete:async()=>({text:turn++===0?JSON.stringify(plan):program})}},{taskId:wf.taskIds.Save!,sourceRunId:first.id,traces});
    expect(compiled.ok,compiled.ok?"":compiled.error).toBe(true);if(!compiled.ok)return;
    const [task]=await rig.handle.db.select().from(tasks).where(eq(tasks.id,wf.taskIds.Save!));
    expect((await promoteTask({db:rig.handle.db},{taskId:task!.id,scriptId:compiled.script.id,expectContentHash:task!.contentHash})).promoted).toBe(true);
    const modelCalls=calls, second=await fire("static");
    expect(second.status,second.error??"").toBe("succeeded");expect(calls).toBe(modelCalls);
    partial=true;
    const third=await fire("recover");expect(third.status,third.error??"").toBe("succeeded");expect(third.modeUsed).toBe("compiled");
    expect(calls).toBe(modelCalls+1);
    expect(saved.size).toBe(300);expect([...writes.values()].every(n=>n===1)).toBe(true);
    const recovery=(await loadRunTraces(rig.handle.db,[third.id],rig.blobs))[0]!;
    expect(recovery.entries.some(e=>e.payload.action==="deopt_recovery")).toBe(true);
    expect(recovery.entries.some(e=>e.payload.action==="sdk.invocation"&&e.payload.language==="python")).toBe(true);
  } finally {
    await rig?.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await fetch(`${worker}/v1/sessions/${sessionId}?generation=1`,{method:"DELETE",headers});
  }
},180000);
