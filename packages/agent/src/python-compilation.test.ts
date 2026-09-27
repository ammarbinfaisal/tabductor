import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { TraceRecorder } from "@tabductor/browser";
import { readSdkEvidence } from "@tabductor/compiler";
import { createRunWorkspace } from "./workspace.js";
import { localPythonRunnerForTest } from "./python-runner.js";
import { pythonFixture, remoteRef } from "./python-test-support.js";
import { validatePythonCandidate } from "./python-validation.js";

it.each([false, true])("compiles recorded Python data flow with optional assertions (assertion: %s)",async(includeAssertion)=>{
  const entries:Array<{seq:number;kind:string;payload:Record<string,unknown>}>=[];
  const trace:TraceRecorder={record:async(kind,payload)=>{entries.push({seq:entries.length,kind,payload});},flush:async()=>{},close:async()=>{}};
  const data=Array.from({length:100},(_,i)=>({id:`record-${i}`,text:`Quoted \"value\" ${i}`}));
  const blobs=new Map<string,Buffer>();let state:unknown;
  const workspace=createRunWorkspace({put:async b=>{const id=String(blobs.size);blobs.set(id,b);return id;},get:async id=>blobs.get(id)!},
    {get:async()=>state,set:async s=>{state=s;}});
  const runner=localPythonRunnerForTest(fileURLToPath(new URL("../../../vendor/browser-harness/src/browser_harness/tabductor_runner.py",import.meta.url))).open!({runId:"compile",leaseGeneration:1});
  try {
    const f=pythonFixture();
    f.calls.mockImplementation(async(call)=>{
      if(call.member==='evaluate')return data;
      if(call.member==='request')return remoteRef('APIRequestContext');
      if(call.member==='post')return remoteRef('APIResponse');
      if(call.member==='ok')return true;
      if(call.member==='url')return 'https://fixture.test';
      return null;
    });
    const python=f.tool({pythonRunner:runner,workspace,trace});
    const collect="import json\nrows=page.evaluate('() => window.fixtureRows')\nif len(rows)!=100 or any(not isinstance(r.get('id'),str) or not isinstance(r.get('text'),str) for r in rows) or len({r['id'] for r in rows})!=100: browser.deopt(reason='shape changed')\nopen('rows.json','w').write(json.dumps(rows))";
    const save="import json\nrows=json.load(open('rows.json'))\nresponse=context.request.post('/save',data={'rows':rows})\nif not response.ok: browser.deopt(reason='save failed')\nassert page.evaluate('() => window.savedRows') == rows\nbrowser.done()";
    const saving = includeAssertion ? save : save.split("\n").filter(line => !line.startsWith("assert ")).join("\n");
    expect(await python.execute({source:collect})).toMatchObject({ok:true});
    expect(await python.execute({source:saving})).toMatchObject({ok:true,terminal:{outcome:'done'}});
    const evidence=readSdkEvidence({runId:"compile",entries});
    const selected=evidence.operations.filter(o=>!o.name.startsWith('internal.')&&!['playwright.open','playwright.close'].includes(o.name));
    const guard=selected.find(o=>o.args.member==='evaluate')!;
    const plan={goal:"save rows",guards:[{operationId:guard.operationId,condition:"100 rows with ids"}],steps:selected.filter(o=>o!==guard).map(o=>({operationId:o.operationId,why:"required"})),bindings:[],checkpoints:[],discarded:[],recoveryPrompt:"Inspect destination"};
    const source="def run(page, context, browser):\n    try:\n"+(collect+'\n'+saving).split('\n').map(line=>'        '+line).join('\n')+"\n    except Exception as error:\n        browser.deopt(reason=str(error))";
    expect(await validatePythonCandidate(runner,source,evidence,plan)).toEqual({ok:true});
    expect((await validatePythonCandidate(runner,source.replace("json.dumps(rows)",JSON.stringify(JSON.stringify(data))),evidence,plan)).ok).toBe(false);
  } finally { await runner.close!(); }
},20000);
