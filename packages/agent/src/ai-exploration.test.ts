import { expect, it, vi } from "vitest";
import { AppError } from "@tabductor/core";
import type { RunSession } from "@tabductor/browser";
import type { RecordOutcome, StoredDestination } from "@tabductor/engine";
import { pythonFixture } from "./python-test-support.js";

const url = "https://fixture.test/records";
const mapping: StoredDestination = {id:"d1",revision:1,destinationKey:url,canonicalUrl:url,
  fields:[{packetField:"id",label:"URL",location:"property"},{packetField:"body",label:"Text",location:"property"}],
  identityField:"id",verificationFields:["id","body"],dedupe:"search-before-create"};
function fixture(compiled = false) {
  let state: unknown = {};
  const progress = {get:async()=>state,set:async(value:unknown)=>{state=value;}};
  const record = vi.fn(async(_outcome: RecordOutcome)=>{});
  const calls = vi.fn(async(method:string,args:Record<string,unknown>)=>{
    if (method === "click" && args.selector === "old") throw new AppError("browser_timeout","Outcome uncertain",{details:{outcomeUncertain:true}});
    return {url,text:"Observed saved record"};
  });
  const fixture=pythonFixture();
  fixture.session.page.url=()=>url;
  fixture.calls.mockImplementation(async(call)=>{
    if(call.member==='click'&&call.args[0]==='old')throw new AppError('browser_timeout','Outcome uncertain',{details:{outcomeUncertain:true}});
    return call.member==='inner_text'?'Observed saved record':null;
  });
  const deps={compiled,progress,recordOutcome:record,verificationContext:{mapping,packet:{id:'record-1',body:'Body'}}};
  return {progress,record,calls:fixture.calls,session:fixture.session,deps,code:fixture.tool(deps)};

}

it("lets AI inspect and correct an uncertain action, assess the result and finish without prescribed verification",async()=>{
  const f = fixture();
  const result=await f.code.execute({source:`try:
    page.click('old')
except Exception: pass
page.inner_text('body')
page.click('corrected')
browser.record.outcome(collection='items',recordKey='item-1',status='saved',reason='Observed the saved identity and body in the custom editor')
browser.done(result='saved')`});
  expect(result, JSON.stringify(result)).toMatchObject({ok:true,terminal:{outcome:"done"}});
  expect(f.calls).toHaveBeenCalledTimes(3);
  expect(f.record).toHaveBeenCalledWith({collection:"items",recordKey:"item-1",status:"saved",reason:"Observed the saved identity and body in the custom editor"});
  expect(f.record.mock.calls[0]?.[0]?.verification).toBeUndefined();
  expect(await f.progress.get()).toMatchObject({requiresReconciliation:true});
});

it("keeps uncertain-effect and verified-completion guards in static mode",async()=>{
  const f = fixture(true);
  const result=await f.code.execute({source:`def run(page, context, browser):
    try:
        page.click('old')
        page.click('corrected')
    except Exception as error:
        browser.deopt(reason=str(error))`});
  expect(result).toMatchObject({ok:true,terminal:{outcome:"deopt"}});
  expect(f.calls).toHaveBeenCalledOnce();
  expect(await f.code.execute({source:"def run(page, context, browser):\n    browser.record.outcome(collection='items',recordKey='item-1',status='saved',reason='unsupported assertion')"})).toMatchObject({ok:true,terminal:{outcome:'deopt'}});
  expect(await f.code.execute({source:"def run(page, context, browser):\n    browser.done()"})).toMatchObject({ok:true,terminal:{outcome:'deopt'}});
  expect(f.record).not.toHaveBeenCalled();
});

it("rejects invalid JavaScript before dispatch",async()=>{
  const f=fixture();
  expect(await f.code.execute({source:`page.evaluate("document.querySelector('[data-testid='tweetText']')")`})).toMatchObject({ok:false,error:expect.stringContaining('JavaScript syntax is invalid')});
  expect(f.calls).not.toHaveBeenCalled();
  expect((await f.progress.get() as Record<string,unknown>).requiresReconciliation).not.toBe(true);
});
