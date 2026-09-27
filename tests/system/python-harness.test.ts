import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { browserHelpers, tasks, traceEntries } from "@tabductor/db";
import { createPromptWorkflow, triggerTask } from "@tabductor/engine";
import { compileTask, loadRunTraces, promoteTask, readSdkEvidence } from "@tabductor/compiler";
import { createCamoufoxWorkerDriver } from "@tabductor/browser";
import { remotePythonRunner, localPythonRunnerForTest, validatePythonCandidate } from "@tabductor/agent";
import { fileURLToPath } from "node:url";
import { AllowAllGate } from "@tabductor/policy";
import { startAgentRig, type AgentRig } from "./agent-support.js";
import { eventsOfType, runsForTask, waitFor } from "./engine-support.js";

let rig: AgentRig | undefined;
afterEach(async()=>{await rig?.stop();rig=undefined;});

it.skipIf(!process.env.CAMOUFOX_TEST_URL)("compiles a Python Camoufox writer, writes a different record without a model, and recovers after a layout change",async()=>{
  const workerUrl=process.env.CAMOUFOX_TEST_URL!;
  const token=process.env.CAMOUFOX_TEST_TOKEN ?? "harness-fixture-token";
  const sessionId="harness-fixture";
  const response=await fetch(`${workerUrl}/v1/sessions`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","x-tabductor-rpc-version":"1"},body:JSON.stringify({session_id:sessionId,generation:1,profile_dir:"harness-fixture"})});
  expect(response.status,await response.text()).toBe(200);
  const pythonRunner=process.env.PYTHON_RUNNER_TEST_URL
    ? remotePythonRunner(process.env.PYTHON_RUNNER_TEST_URL,process.env.PYTHON_RUNNER_TEST_TOKEN!)
    : localPythonRunnerForTest(fileURLToPath(new URL("../../vendor/browser-harness/src/browser_harness/tabductor_runner.py",import.meta.url)));
  const python=(label:string)=>`from playwright.sync_api import Page, expect, TimeoutError
assert isinstance(page, Page)
page.goto(workflow.input['url'])
target = page.get_by_role('textbox', name='${label}')
if target.count() != 1: workflow.deopt(reason='Editor changed')
target.fill(workflow.input['body'])
page.get_by_role('button', name='Save').click()
expect(page.locator('article')).to_have_text(workflow.input['id']+' '+workflow.input['body'], timeout=1000)
workflow.emit(type='record.saved',packet={'id':workflow.input['id'],'body':workflow.input['body']},dedupeKey=workflow.input['id'])
workflow.done()`;
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
  const fixtureHost=process.env.CAMOUFOX_FIXTURE_HOST ?? "127.0.0.1";
  await new Promise<void>(resolve=>server.listen(0,fixtureHost,resolve));
  const url=`http://${fixtureHost}:${(server.address() as {port:number}).port}`;
  const program=(label:string)=>"from playwright.sync_api import expect\ndef run(page, context, workflow):\n    try:\n"+python(label).split("\n").map(line=>"        "+line).join("\n")+"\n    except Exception as error:\n        workflow.deopt(reason=str(error))";
  let modelCalls=0;
  try {
    rig=await startAgentRig({compiled:{},pythonRunner,
      gate:new AllowAllGate({navAllowlist:[fixtureHost]}),
      chrome:{wsUrl:workerUrl.replace(/^http/,"ws"),version:"camoufox",close:async()=>{}},
      driver:{connect:()=>createCamoufoxWorkerDriver({token,sessionId,generation:1}).connect(workerUrl)},llmFor:()=>({complete:async request=>{
      modelCalls++;
      expect(request.tools.map(t=>t.name)).toEqual(["browser.python", "browser.screenshot"]);
      if (modelCalls === 1) return { usage: { in: 1, out: 1 }, toolCalls: [{ id: "image", name: "browser.screenshot", args: {} }] };
      if (modelCalls === 2) expect(request.messages.some(m => m.toolResults?.some(r => r.name === "browser.screenshot" && r.result.images?.[0]?.mime === "image/png"))).toBe(true);
      const recovery=`expect(page.locator('article')).to_have_text(workflow.input['id']+' '+workflow.input['body'], timeout=10000)
workflow.emit(type='record.saved',packet={'id':workflow.input['id'],'body':workflow.input['body']},dedupeKey=workflow.input['id'])
workflow.done()`;
      return {usage:{in:1,out:1},toolCalls:[{id:"code",name:"browser.python",args:{source:delayedCommit?recovery:python(changed?"Record content":"Body")}}]};
    }})});
    const definition = await createPromptWorkflow(rig.handle.db, { accountId: "acct_local", userId: "user_local", prompt: "Write and verify this record" });
    const wf = {taskIds: {Write: definition.versionId}};
    const fire=async(id:string,body:string)=>{
      const { event } = await triggerTask(rig!.handle.db, {taskId: wf.taskIds.Write, packet: {id,body,url:`${url}/?record=${id}`}});
      return waitFor("SDK writer to settle",async()=>{
        const rows=await runsForTask(rig!,wf.taskIds.Write!);
        const row = rows.find(r=>r.triggerEventId===event.eventId);
        return row && ["succeeded","failed"].includes(row.status) ? row : false;
      },60000);
    };
    const first=await fire("one","first body");
    expect(first.status,first.error??"").toBe("succeeded");
    const traces=await loadRunTraces(rig.handle.db,[first.id],rig.blobs);
    const evidence=readSdkEvidence(traces[0]!);
    expect(evidence.sourceLanguage).toBe("python");
    const plan={goal:"Write record",guards:evidence.operations.filter(o=>o.name==="playwright.call" && o.args.member==="count").map(o=>({operationId:o.operationId,condition:"Body editor exists"})),
      steps:evidence.operations.filter(o=>!(o.name==="playwright.call" && o.args.member==="count") && !o.name.startsWith("internal.")).map(o=>({operationId:o.operationId,why:"required"})),bindings:[{source:"workflow.input",use:"record fields"}],checkpoints:[],discarded:evidence.operations.filter(o=>o.name.startsWith("internal.")).map(o=>({operationId:o.operationId,why:"No task file dependencies"})),recoveryPrompt:"Inspect changed editor"};
    let compileTurn=0;
    const compiled=await compileTask({db:rig.handle.db,validatePython:(source,evidence,plan)=>validatePythonCandidate(pythonRunner,source,evidence,plan),llm:{complete:async()=>({text:compileTurn++===0?JSON.stringify(plan):program("Body")})}},{taskId:wf.taskIds.Write!,sourceRunId:first.id,traces});
    expect(compiled.ok,compiled.ok?"":compiled.error).toBe(true);
    if(!compiled.ok) return;
    const [task]=await rig.handle.db.select().from(tasks).where(eq(tasks.id,wf.taskIds.Write!));
    expect((await promoteTask({db:rig.handle.db},{taskId:task!.id,scriptId:compiled.script.id,expectContentHash:task!.contentHash})).promoted).toBe(true);
    const calls=modelCalls;
    const second=await fire("two","second body");
    expect(second.status,second.error??"").toBe("succeeded");
    const secondTrace=await loadRunTraces(rig.handle.db,[second.id],rig.blobs);
    const failures=secondTrace[0]!.entries.filter(e=>e.payload.action==="deopt" || e.payload.name==="run.deopt" ||
      e.payload.action==="sdk.operation" && (e.payload.error || (e.payload.result as {ok?:boolean})?.ok===false));
    expect(modelCalls,JSON.stringify(failures.map(e=>e.payload))).toBe(calls);
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
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rig?.stop(); rig=undefined;
    await fetch(`${workerUrl}/v1/sessions/${sessionId}?generation=1`,{method:"DELETE",headers:{authorization:`Bearer ${token}`,"x-tabductor-rpc-version":"1"}});
  }
},180000);
