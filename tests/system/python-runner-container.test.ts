import { expect, it } from "vitest";
import { remotePythonRunner } from "@tabductor/agent";

const url=process.env.PYTHON_RUNNER_TEST_URL;
const bootstrap=async(name:string)=>({ok:true,value:name==="playwright.open"?{page:{$ref:{id:"page",class:"Page",scope:"s"}},context:{$ref:{id:"context",class:"BrowserContext",scope:"s"}}}:null});
const token=process.env.PYTHON_RUNNER_TEST_TOKEN ?? "";
it.skipIf(!url)("isolates Python from network, credentials and the host filesystem",async()=>{
  const run=remotePythonRunner(url!,token);
  const result=await run(`import os, socket
from pathlib import Path
assert os.getuid() == 10001
assert 'PYTHON_RUNNER_TOKEN' not in os.environ
assert not Path('/var/run/docker.sock').exists()
assert not Path('/profiles').exists()
try:
    Path('/opt/forbidden').write_text('x')
    raise AssertionError('writable root')
except OSError: pass
try:
    socket.create_connection(('1.1.1.1',443),timeout=0.2)
    raise AssertionError('network escaped')
except OSError: pass
Path('/tmp/scratch').write_text('allowed')
print('isolation passed')`,bootstrap,{});
  expect(result).toMatchObject({outcome:"completed",value:{output:expect.stringContaining("isolation passed")}});
});
it.skipIf(!url)("rejects unauthenticated invocations and terminates runaway Python",async()=>{
  const rejected=await remotePythonRunner(url!,"invalid")("print('bad')",async()=>null,{});
  expect(rejected).toMatchObject({outcome:"error",calls:0});
  const result=await remotePythonRunner(url!,token)("while True: pass",bootstrap,{wallClockMs:100});
  expect(result).toMatchObject({outcome:"killed",calls:1});
});
it.skipIf(!url)("cancels a running container after draining an acknowledged host operation",async()=>{
  const cancellation=new AbortController();
  const calls:string[]=[];
  const result=await remotePythonRunner(url!,token)("page.goto('https://example.test')\nwhile True: pass",async(name)=>{
    if(name==="playwright.open")return bootstrap(name);
    calls.push(name);
    setTimeout(()=>cancellation.abort(),20);
    return {ok:true,value:{written:true}};
  },{signal:cancellation.signal});
  expect(result).toMatchObject({outcome:"error",error:expect.stringContaining("run_cancelled")});
  expect(calls).toEqual(["playwright.call"]);
});
