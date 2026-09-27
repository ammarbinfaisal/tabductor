import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createRunWorkspace } from "./workspace.js";
import { localPythonRunnerForTest } from "./python-runner.js";
import { pythonFixture } from "./python-test-support.js";
import { compareDataset } from "./dataset-verification.js";

function workspace() {
  const blobs = new Map<string,Buffer>();
  let state: unknown;
  const storage = {put:async(bytes:Buffer)=>{const ref=createHash("sha256").update(bytes).digest("hex");blobs.set(ref,bytes);return ref;},get:async(ref:string)=>blobs.get(ref)!};
  const store = {get:async()=>state,set:async(v:unknown)=>{state=v;}};
  return {workspace:createRunWorkspace(storage,store),restore:()=>createRunWorkspace(storage,store)};
}
const factory = () => localPythonRunnerForTest(fileURLToPath(new URL("../../../vendor/browser-harness/src/browser_harness/tabductor_runner.py",import.meta.url)));

it("keeps variables across Python cells and files across exceptions and runner replacement",async()=>{
  const f = workspace();
  let runner = factory().open!({runId:"workspace",leaseGeneration:1});
  const make = () => pythonFixture().tool({pythonRunner:runner,workspace:f.workspace});
  try {
    expect(await make().execute({source:"from pathlib import Path\nPath('records.json').write_text('[1,2,3]')\ntransient=9\nraise ValueError('recover me')"})).toMatchObject({ok:false,error:expect.stringContaining("recover me")});
    expect(await make().execute({source:"assert transient == 9\nassert open('records.json').read() == '[1,2,3]'\nprint('persisted')"})).toMatchObject({ok:true,value:{output:expect.stringContaining("persisted")}});
    await runner.close!();
    runner = factory().open!({runId:"workspace",leaseGeneration:2});
    const restored = pythonFixture().tool({pythonRunner:runner,workspace:f.restore()});
    expect(await restored.execute({source:"assert 'transient' not in globals()\nassert open('records.json').read() == '[1,2,3]'"})).toMatchObject({ok:true});
  } finally { await runner.close!(); }
});

it("records imported SDK calls and preserves complete stdout with a bounded preview",async()=>{
  const runner = factory();
  const record = vi.fn();
  const f=workspace(), fixture=pythonFixture();
  const tool=fixture.tool({pythonRunner:runner,workspace:f.workspace,trace:{record,flush:async()=>{},close:async()=>{}}});
  const result=await tool.execute({source:"from playwright.sync_api import page\nfor i in range(180):\n    assert page.title() == 'Observed but never printed'\nprint('x'*120000)"});
  expect(result).toMatchObject({ok:true,value:{outputChars:120001,output:expect.any(String)}});
  expect(record.mock.calls.filter(c=>c[1].name==="playwright.call" && c[1].phase==="finished")).toHaveLength(180);
  const saved=await f.workspace.tools().find(t=>t.name==="output.read")!.execute({invocationId:(result.value as {invocationId:string}).invocationId,offset:0,limit:4000});
  expect(saved).toMatchObject({ok:true,value:{characters:120001}});

});

it("commits helpers and files even when the cell finishes the task",async()=>{
  const f=workspace(), define=vi.fn(async(name:string,source:string)=>({name,source,revision:"v2"}));
  const tool=pythonFixture().tool({pythonRunner:factory(),workspace:f.workspace,helpers:{list:async()=>[],define}});
  expect(await tool.execute({source:"open('agent_helpers.py','w').write('def example(): return 1')\nopen('result.json','w').write('[42]')\nbrowser.done()"})).toMatchObject({ok:true,terminal:{outcome:"done"}});
  expect(define).toHaveBeenCalledOnce();
  expect(await f.workspace.read("result.json")).toEqual({content:"[42]",encoding:"utf8"});
});

it("rejects workspace traversal and leaves the committed manifest intact on failure",async()=>{
  const f=workspace();
  await f.workspace.commit({"good.json":{content:"[]",encoding:"utf8"}});
  await expect(f.workspace.commit({"../outside":{content:"bad",encoding:"utf8"}})).rejects.toThrow("relative workspace");
  expect(Object.keys(await f.workspace.snapshot())).toEqual(["good.json"]);
});

it("makes complete error output readable after restoring the run workspace",async()=>{
  const f=workspace();
  const result=await pythonFixture().tool({pythonRunner:factory(),workspace:f.workspace}).execute({source:"print('first-line')\nprint('x'*12000)\nraise ValueError('failed after output')"});
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("first-line");
    expect(result.error).toContain("omitted; use browser.output.read");
  }
  const invocationId=(result.value as {invocationId:string}).invocationId;
  const read=f.restore().tools().find(t=>t.name==="output.read")!;
  expect(await read.execute({invocationId,offset:0,limit:11})).toMatchObject({ok:true,value:{text:"first-line\n",characters:12012,nextOffset:11}});
});

it("detects text corruption despite 100 distinct rows, plus duplicates and missing fields",()=>{
  const expected=Array.from({length:100},(_,i)=>({id:`post-${i}`,text:`A \"quoted\" post ${i}\nnext line`,author:"fixture"}));
  const actual=expected.map(r=>({...r,text:r.text.replace(/\n/g," ")}));
  expect(compareDataset(expected,actual,"id",["text","author"],true).verified).toBe(true);
  actual[17]!.text=actual[17]!.text.replace(/"/g,"");
  expect(compareDataset(expected,actual,"id",["text","author"],true)).toMatchObject({verified:false,actualCount:100,mismatches:[{field:"text"}]});
  expect(compareDataset(expected,[...expected,expected[0]!],"id",["text"]).verified).toBe(false);
  expect(compareDataset(expected,expected.map(({id})=>({id})),"id",["text"]).verified).toBe(false);
});
