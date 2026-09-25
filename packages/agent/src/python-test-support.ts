import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { ProxyCommand, ProxyCall, RunSession, TraceRecorder } from "@tabductor/browser";
import { localPythonRunnerForTest } from "./python-runner.js";
import { pythonTool } from "./python-tool.js";
import type { AgentToolDeps } from "./tools.js";
export const testRunner=()=>localPythonRunnerForTest(fileURLToPath(new URL("../../../vendor/browser-harness/src/browser_harness/tabductor_runner.py",import.meta.url)));
export const remoteRef=(kind:string)=>({$ref:{id:`object-${kind}`,class:kind,scope:"test"}});
export function pythonFixture(){
  const entries:Array<{seq:number;kind:string;payload:Record<string,unknown>}>=[];
  const trace:TraceRecorder={record:vi.fn(async(kind,payload)=>{entries.push({seq:entries.length,kind,payload});}),flush:vi.fn(async()=>{}),close:async()=>{}};
  let state:unknown={};
  const progress={get:async()=>state,set:async(v:unknown)=>{state=v;}};
  const calls=vi.fn(async(call:ProxyCall):Promise<unknown>=>{
    if(["locator","get_by_role","get_by_label"].includes(call.member))return remoteRef("Locator");
    if(call.member==="count")return 1;
    if(call.member==="title"||call.member==="inner_text")return "Observed but never printed";
    if(call.member==="url")return "https://fixture.test";
    if(call.member==="screenshot")return {$bytes:Buffer.from("image").toString("base64")};
    return null;
  });
  const session={page:{url:()=>"https://fixture.test",proxy:async(command:ProxyCommand)=>{
    if(command.command==="open")return {page:remoteRef("Page"),context:remoteRef("BrowserContext")};
    if(command.command==="close")return null;
    if(command.command==="inspect")return {type:"text",origin:"https://fixture.test",pageOrigin:"https://fixture.test"};
    if(command.command==="expect")return remoteRef("LocatorAssertions");
    return calls(command.call!);
  }}} as unknown as RunSession;
  const tool=(options:Partial<AgentToolDeps>={})=>pythonTool({session,trace,progress,pythonRunner:testRunner(),emit:async()=>({outcome:"deduped"}),...options});
  return {entries,trace,progress,calls,session,tool};
}
