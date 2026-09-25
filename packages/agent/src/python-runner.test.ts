import { expect, it, vi } from "vitest";
import { AppError } from "@tabductor/core";
import { readSdkEvidence } from "@tabductor/compiler";
import type { CaptchaService } from "@tabductor/engine";
import { pythonFixture } from "./python-test-support.js";

it("records Python calls, results and pinned helper provenance",async()=>{
  const f=pythonFixture();
  const helper={name:"agent_helpers",revision:"python-v1",source:"def write(text):\n    page.locator('input').fill(text)"};
  const result=await f.tool({input:{body:"current"},helpers:{list:async()=>[helper],define:vi.fn()}}).execute({source:"import agent_helpers\nagent_helpers.write(workflow.input['body'])\nexpect(page.locator('input')).to_have_value(workflow.input['body'])\nworkflow.done()"});
  expect(result).toMatchObject({ok:true,terminal:{outcome:"done"}});
  expect(f.calls.mock.calls.filter(([c])=>c.member==="fill")).toHaveLength(1);
  const evidence=readSdkEvidence({runId:"r",entries:f.entries});
  expect(evidence.sourceLanguage).toBe("python");expect(evidence.helpers).toEqual([helper]);
  expect(evidence.operations.some(o=>o.name==="internal.helpers.use"&&o.args.revision==="python-v1")).toBe(true);
});

it("keeps uncertain effects visible while allowing later AI exploration",async()=>{
  const f=pythonFixture();
  f.calls.mockRejectedValueOnce(new AppError("browser_timeout","uncertain",{details:{outcomeUncertain:true}}));
  const tool=f.tool();
  expect(await tool.execute({source:"page.click('button')"})).toMatchObject({ok:false});
  expect(await tool.execute({source:"page.click('corrected')"})).toMatchObject({ok:true});
  expect(await f.progress.get()).toMatchObject({requiresReconciliation:true,inFlight:null});
  expect(f.calls).toHaveBeenCalledTimes(2);
});

it("reports browser failures without a Python traceback while preserving output",async()=>{
  const f=pythonFixture();
  f.calls.mockRejectedValueOnce(new AppError("browser_timeout","Browser operation timed out; inspect the page before repeating effects."));
  const result=await f.tool().execute({source:"print('4 1 <span class=\\\"menu-text\\\">My Courses</span>')\npage.click('button')"});
  expect(result).toMatchObject({ok:false,error:"AppError: Browser operation timed out; inspect the page before repeating effects.\nOutput:\n4 1 <span class=\"menu-text\">My Courses</span>\n"});
});

it("reports invalid workflow API calls without a Python traceback",async()=>{
  const f=pythonFixture();
  const result=await f.tool({captcha:{} as CaptchaService}).execute({source:"workflow.captcha.wait(id='job-1')"});
  expect(result).toMatchObject({
    ok:false,
    error:'Invalid API call to "captcha.wait": missing required argument "job_id"; unexpected argument "id".',
  });
});

it("bounds execution without replaying an acknowledged operation",async()=>{
  const f=pythonFixture();
  await expect(f.tool().execute({source:"page.click('button')\nwhile True: pass",timeoutMs:100})).rejects.toMatchObject({code:"resource_limit_exceeded"});
  expect(f.calls).toHaveBeenCalledOnce();expect(await f.progress.get()).toMatchObject({inFlight:null});
});

it("offloads large read evidence after redacting sensitive fields",async()=>{
  const f=pythonFixture();f.calls.mockResolvedValue({text:"x".repeat(70000),password:"must not persist"});
  expect(await f.tool().execute({source:"page.evaluate('() => window.data')"})).toMatchObject({ok:true});
  const saved=vi.mocked(f.trace.record).mock.calls.find(c=>c[1].evidenceArtifact&&c[1].phase==="finished");
  expect(saved?.[2]?.mime).toBe("application/json");expect(saved?.[2]?.bytes.toString()).not.toContain("must not persist");
  expect(JSON.parse(saved![2]!.bytes.toString()).result.value.text).toHaveLength(70000);
});

it("does not execute helper initialization effects",async()=>{
  const f=pythonFixture();
  const result=await f.tool({helpers:{list:async()=>[{name:"agent_helpers",revision:"bad",source:"page.click('duplicate')"}],define:vi.fn()}}).execute({source:"print('repair the module')"});
  expect(result).toMatchObject({ok:true});expect(f.calls).not.toHaveBeenCalled();
});

it("discovers exact schemas and rejects retired aliases",async()=>{
  const f=pythonFixture();const tool=f.tool();
  expect(await tool.execute({source:"assert workflow.describe(name='Locator.click')['parameters']\nassert 'source' not in workflow.describe(name='done')['parameters']['properties']\nfrom browser_harness import api"})).toMatchObject({ok:false,error:expect.stringContaining("cannot import name 'api'")});
  expect(f.calls).not.toHaveBeenCalled();
});

it.each(["await page.title()", "page.click('button')\nif True print('bad')"])("rejects invalid Python before opening a browser scope: %s", async source => {
  const f = pythonFixture();
  const proxy = vi.fn(f.session.page.proxy!);
  f.session.page.proxy = proxy;
  const result = await f.tool().execute({ source });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Nothing was executed") });
  if (source.startsWith("await")) expect(result).toMatchObject({ error: expect.stringContaining("synchronous") });
  expect(proxy.mock.calls.some(([command]) => command.command === "open")).toBe(false);
  expect(f.calls).not.toHaveBeenCalled();
});

it("exposes task services without destination role protocols", async () => {
  const f = pythonFixture();
  const tool = f.tool();
  expect(tool.description).not.toContain("workflow.destination");
  expect(tool.description).not.toContain("workflow.secrets.fill");
  expect(await tool.execute({ source: "assert not any('destination' in name for name in workflow.describe()['workflow'])" })).toMatchObject({ ok: true });
  expect(await tool.execute({ source: "workflow.describe(name='destination.contract.publish')" })).toMatchObject({ ok: false, error: expect.stringContaining("unavailable") });
});

it("assesses tracked record outcomes without a destination mapping", async () => {
  const f = pythonFixture(), recordOutcome = vi.fn(async () => {});
  const tool = f.tool({recordOutcome, recordInput: {key: "id", packet: {id: "item-1"}}});
  expect(await tool.execute({source: "workflow.record.outcome(status='saved', reason='Observed the saved item')"})).toMatchObject({ok:true});
  expect(recordOutcome).toHaveBeenCalledWith({status:"saved", reason:"Observed the saved item"});
});

it("distinguishes undispatched from uncertain operations",async()=>{
  const f=pythonFixture();const tool=f.tool();
  f.calls.mockRejectedValueOnce(new AppError("browser_invalid_argument","not dispatched",{details:{outcomeUncertain:false}}));
  expect(await tool.execute({source:"page.click('a')"})).toMatchObject({ok:false});
  expect((await f.progress.get() as Record<string,unknown>).requiresReconciliation).not.toBe(true);
  f.calls.mockRejectedValueOnce(new AppError("browser_timeout","unknown",{details:{outcomeUncertain:true}}));
  expect(await tool.execute({source:"page.click('b')"})).toMatchObject({ok:false});
  expect(await f.progress.get()).toMatchObject({requiresReconciliation:true});
});
