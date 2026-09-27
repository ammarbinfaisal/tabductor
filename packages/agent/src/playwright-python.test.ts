import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { localPythonRunnerForTest } from "./python-runner.js";
import { pythonTool } from "./python-tool.js";
import type { ProxyCommand, ProxyOptions, RunSession } from "@tabductor/browser";
import { validatePythonCandidate } from "./python-validation.js";
import { readSdkEvidence } from "@tabductor/compiler";
import { AppError } from "@tabductor/core";
import { pythonFixture } from "./python-test-support.js";

const runner=localPythonRunnerForTest(fileURLToPath(new URL("../../../vendor/browser-harness/src/browser_harness/tabductor_runner.py",import.meta.url)));
const reference=(type:string,id="id-"+type)=>({$ref:{class:type,id,scope:"test"}});

it("supports standard sync_api imports, annotations and typed errors", async () => {
  const f = pythonFixture();
  f.calls.mockImplementation(async call => {
    if (call.member === "locator") return reference("Locator");
    throw new AppError(call.member === "title" ? "browser_timeout" : "browser_stale_target", "Browser operation failed");
  });
  const source = `from playwright.sync_api import Page, BrowserContext, Locator, Error, TimeoutError as PlaywrightTimeoutError, expect
import playwright.sync_api as pw
from playwright import sync_api
def run(page: Page, context: BrowserContext, browser):
    assert isinstance(page, Page) and isinstance(context, BrowserContext)
    assert pw.page is page and sync_api.context is context
    assert isinstance(page.locator('body'), Locator)
    assert not isinstance(context, Page)
    try:
        page.title()
    except PlaywrightTimeoutError as error:
        assert isinstance(error, Error)
    else:
        raise AssertionError('timeout was not raised')
    try:
        page.url
    except PlaywrightTimeoutError:
        raise AssertionError('non-timeout was misclassified')
    except Error:
        pass
    else:
        raise AssertionError('error was not raised')
    browser.done(result='standard imports work')
\nrun(page, context, browser)`;
  expect(await f.tool().execute({ source })).toMatchObject({ ok: true, terminal: { outcome: "done", result: "standard imports work" } });
});

it("supports standard sync_api imports in compiled entry points", async () => {
  const source = `from playwright.sync_api import Page, BrowserContext, expect, Error, TimeoutError
import playwright.sync_api as pw
from playwright import sync_api
def run(page: Page, context: BrowserContext, browser):
    assert isinstance(page, Page) and isinstance(context, BrowserContext)
    assert pw.page is page and sync_api.context is context
    assert issubclass(TimeoutError, Error)
    expect(page.locator('body')).to_have_text('Fixture')
    browser.done(result='compiled imports work')`;
  expect(await pythonFixture().tool({ compiled: true }).execute({ source })).toMatchObject({ ok: true, terminal: { outcome: "done", result: "compiled imports work" } });
});

it.each(["from playwright.sync_api import sync_playwright", "from playwright import async_api", "import playwright._impl", "from playwright.sync_api import workflow"])("rejects unsupported runtime imports: %s", async source => {
  expect(await pythonFixture().tool({ compiled: true }).execute({ source: source + "\ndef run(page, context, browser): pass" })).toMatchObject({ ok: true, terminal: { outcome: "deopt", reason: expect.stringContaining("ValueError") } });
});

it("keeps persisted browser_harness helper imports compatible", async () => {
  expect(await pythonFixture().tool().execute({ source: "from browser_harness import page as legacy_page, expect as legacy_expect\nfrom playwright.sync_api import page, expect\nassert legacy_page is page and legacy_expect == expect" })).toMatchObject({ ok: true });
});

it("uses only Playwright objects and workflow, with fresh cells and terminal completion",async()=>{
  const methods:string[]=[];
  const session={page:{url:()=>"https://example.test",proxy:async(command:{command:string;call?:{member:string}})=>{
    if(command.command==="open")return {page:reference("Page"),context:reference("BrowserContext")};
    if(command.command==="close")return null;
    if(command.command==="inspect")return {type:"text",origin:"https://example.test",pageOrigin:"https://example.test"};
    methods.push(command.call!.member);
    if(command.call!.member==="get_by_role")return reference("Locator");
    return null;
  }}} as unknown as RunSession;
  const tool=pythonTool({pythonRunner:runner,session,emit:async()=>({outcome:"published",eventId:"e"})});
  expect(tool.name).toBe("browser.python");
  const result=await tool.execute({source:"assert 'api' not in globals()\npage.get_by_role('textbox', name='Name').fill('Alice')\nbrowser.done(result={'saved': True})"});
  expect(result).toMatchObject({ok:true,terminal:{outcome:"done",result:{saved:true}}});
  expect(methods).toEqual(["get_by_role","fill"]);
});

it("pumps callbacks that make nested browser calls without deadlocking",async()=>{
  let callback:string|undefined;
  const received:string[]=[];
  const result=await runner("page.on('load', lambda p: print(p.title()))\npage.goto('https://example.test')",async(name,args,_signal,_wait,ctx)=>{
    if(name==="playwright.open")return {ok:true,value:{page:reference("Page"),context:reference("BrowserContext")}};
    if(name==="playwright.close")return {ok:true,value:null};
    const call=args as {member:string;args:Array<{$callback?:string}>};received.push(call.member);
    if(call.member==="on")callback=call.args[1]!.$callback;
    if(call.member==="goto")await ctx!.requestCallback({id:"callback-1",callback,args:[reference("Page")]});
    return {ok:true,value:call.member==="title"?"Loaded":null};
  });
  expect(result).toMatchObject({outcome:"completed",value:{output:"Loaded\n"}});
  expect(received).toEqual(["on","goto","title"]);
},10000);

it("runs a compiled Python entry point and rejects legacy browser methods",async()=>{
  const calls:string[]=[];
  const result=await runner("def run(page, context, browser):\n    print(page.title())\n    browser.done(result='ok')",async(name)=>{
    calls.push(name);
    return {ok:true,value:name==="playwright.open"?{page:reference("Page"),context:reference("BrowserContext")}:"Page"};
  },{compiled:true});
  expect(result.outcome).toBe("completed");
  expect(calls).toContain("workflow.done");
  const invalid=await runner("page.harness.click('x')",async(name)=>({ok:true,value:name==="playwright.open"?{page:reference("Page"),context:reference("BrowserContext")}:null}));
  expect(invalid.outcome).toBe("error");
});

it("validates Python from complete recorded evidence and rejects sample-bound programs",async()=>{
  const entries:Array<{seq:number;kind:string;payload:Record<string,unknown>}>=[];
  const session={page:{url:()=>"https://example.test",proxy:async(command:{command:string;call?:{member:string}})=>{
    if(command.command==="open")return {page:reference("Page"),context:reference("BrowserContext")};
    if(command.command==="close")return null;
    if(command.command==="inspect")return {type:"text",origin:"https://example.test",pageOrigin:"https://example.test"};
    if(command.command==="expect")return reference("LocatorAssertions");
    if(command.call!.member==="get_by_role")return reference("Locator");
    if(command.call!.member==="count")return 1;
    return null;
  }}} as unknown as RunSession;
  const trace={record:async(kind:string,payload:Record<string,unknown>)=>{entries.push({seq:entries.length,kind,payload});},flush:async()=>{},close:async()=>{}};
  const source="target = page.get_by_role('textbox', name='Name')\nif target.count() != 1: browser.deopt(reason='missing target')\ntarget.fill(browser.input['name'])\nexpect(target).to_have_value(browser.input['name'])\nbrowser.done()";
  const tool=pythonTool({pythonRunner:runner,session,trace,input:{name:"Original"},emit:async()=>({outcome:"published",eventId:"e"})});
  expect(await tool.execute({source})).toMatchObject({ok:true,terminal:{outcome:"done"}});
  const evidence=readSdkEvidence({runId:"r",entries});
  const ops=evidence.operations.filter(op=>!op.name.startsWith("internal.")&&!["playwright.open","playwright.close"].includes(op.name));
  const guard=ops.find(op=>op.args.member==="count")!;
  const plan={goal:"fill current input",guards:[{operationId:guard.operationId,condition:"target exists"}],steps:ops.filter(o=>o!==guard).map(o=>({operationId:o.operationId,why:"work"})),bindings:[],checkpoints:[],discarded:[],recoveryPrompt:"inspect"};
  const compiled="from playwright.sync_api import expect\ndef run(page, context, browser):\n    try:\n"+source.split("\n").map(line=>"        "+line).join("\n")+"\n    except Exception as error:\n        browser.deopt(reason=str(error))";
  expect(await validatePythonCandidate(runner,compiled,evidence,plan)).toEqual({ok:true});
  expect((await validatePythonCandidate(runner,compiled.replaceAll("browser.input['name']","'Original'"),evidence,plan)).ok).toBe(false);

  const fillIndex=ops.findIndex(op=>op.args.member==="fill");
  const hybridPlan={...plan,
    steps:ops.slice(0,fillIndex).filter(op=>op!==guard).map(op=>({operationId:op.operationId,why:"static prefix"})),
    deopts:[{id:"semantic-finish",operationIds:ops.slice(fillIndex).map(op=>op.operationId),
      prompt:"Inspect the current editor, complete the semantic work, verify it, and finish.",
      why:"The remaining choice requires runtime semantic judgment"}]};
  const hybrid=`def run(page, context, browser):
    try:
        target = page.get_by_role('textbox', name='Name')
        if target.count() != 1:
            browser.deopt(reason='target changed')
        browser.deopt(reason='Inspect the current editor, complete the semantic work, verify it, and finish.', evidence={'plannedDeopt': 'semantic-finish'})
    except Exception as error:
        browser.deopt(reason=str(error))`;
  expect(await validatePythonCandidate(runner,hybrid,evidence,hybridPlan)).toEqual({ok:true});
  expect((await validatePythonCandidate(runner,hybrid.replace("'semantic-finish'","'wrong-marker'"),evidence,hybridPlan)).ok).toBe(false);
},20000);

it("replays callback data flow and rejects a sample-bound callback result",async()=>{
  const entries:Array<{seq:number;kind:string;payload:Record<string,unknown>}>=[];
  let callback="";
  const session={page:{url:()=>"https://example.test",proxy:async(command:ProxyCommand,opts:ProxyOptions)=>{
    if(command.command==="open")return {page:reference("Page"),context:reference("BrowserContext")};
    if(command.command==="close")return null;
    if(command.command==="expect")return reference("LocatorAssertions");
    const call=command.call!;
    if(call.member==="locator")return reference("Locator");
    if(call.member==="count")return 1;
    if(call.member==="title")return "Title";
    if(call.member==="on")callback=(call.args[1] as {$callback:string}).$callback;
    if(call.member==="click")await opts.callback!({id:"callback-event",callback,args:[reference("Page")],parentJob:call.operationId});
    return null;
  }}} as unknown as RunSession;
  const trace={record:async(kind:string,payload:Record<string,unknown>)=>{entries.push({seq:entries.length,kind,payload});},flush:async()=>{},close:async()=>{}};
  const source="target=page.locator('button')\nif target.count()!=1: browser.deopt(reason='changed')\npage.on('load',lambda p:(p.title(),browser.input['name'])[1])\ntarget.click()\nexpect(target).to_have_text(browser.input['name'])\nbrowser.done()";
  const tool=pythonTool({session,trace,pythonRunner:runner,input:{name:"Original"},emit:async()=>({outcome:"deduped"})});
  expect(await tool.execute({source})).toMatchObject({ok:true,terminal:{outcome:"done"}});
  const evidence=readSdkEvidence({runId:"callbacks",entries});
  const ops=evidence.operations.filter(o=>!o.name.startsWith("internal.")&&!["playwright.open","playwright.close"].includes(o.name));
  const guard=ops.find(o=>o.args.member==="count")!;
  const plan={goal:"callback",guards:[{operationId:guard.operationId,condition:"target exists"}],steps:ops.filter(o=>o!==guard).map(o=>({operationId:o.operationId,why:"required"})),bindings:[],checkpoints:[],discarded:[],recoveryPrompt:"inspect"};
  const compiled="from playwright.sync_api import expect\ndef run(page, context, browser):\n    try:\n"+source.split("\n").map(line=>"        "+line).join("\n")+"\n    except Exception as error:\n        browser.deopt(reason=str(error))";
  expect(await validatePythonCandidate(runner,compiled,evidence,plan)).toEqual({ok:true});
  expect((await validatePythonCandidate(runner,compiled.replace("p.title(),browser.input['name']","p.title(),'Original'"),evidence,plan)).ok).toBe(false);
},20000);
