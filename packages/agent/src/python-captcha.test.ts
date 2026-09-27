import { expect, it, vi } from "vitest";
import type { CaptchaJob, CaptchaService } from "@tabductor/engine";
import { pythonFixture, testRunner } from "./python-test-support.js";
import { buildBrowserCodeTools } from "./tools.js";
import { runAgentLoop } from "./loop.js";
import type { LlmRequest } from "./llm.js";

function captchaFixture() {
  const pending: CaptchaJob = { id: "job-1", provider: "capsolver", task_type: "ImageToTextTask", status: "pending" };
  const captcha = {
    providers: vi.fn<CaptchaService["providers"]>(async () => []),
    createTask: vi.fn<CaptchaService["createTask"]>(async () => pending),
    getResult: vi.fn<CaptchaService["getResult"]>(async () => ({ ...pending, status: "ready", solution: { text: "private-solution" } })),
    pushVariable: vi.fn<CaptchaService["pushVariable"]>(async () => {}),
  };
  return { ...pythonFixture(), captcha };
}

it("exposes all CAPTCHA operations in Python and advertises their exact schemas", async () => {
  const f = captchaFixture();
  const result = await f.tool({ captcha: f.captcha }).execute({ source: `
assert captcha.providers() == []
methods = ['providers', 'create_task', 'get_result', 'wait', 'solve', 'push_variable']
for method in methods:
    name = 'captcha.' + method
    assert name in browser.describe()['services']
    assert browser.describe(name=name)['name'] == name
assert 'idempotency_key' in browser.describe(name='captcha.solve')['parameters']['required']
args = dict(provider='capsolver', task={'type': 'ImageToTextTask', 'body': 'private-image'}, idempotency_key='observed-challenge')
job = captcha.create_task(**args)
assert job['status'] == 'pending'
assert captcha.get_result(job_id=job['id'])['solution']['text'] == 'private-solution'
assert captcha.wait(job_id=job['id'], wait_ms=0)['status'] == 'ready'
assert captcha.solve(**args, wait_ms=0)['id'] == job['id']
assert captcha.push_variable(job_id=job['id'], name='answer', value={'text': 'private-variable'})['accepted']
print('private-solution')
` });
  expect(result).toMatchObject({ ok: true });
  expect(f.captcha.createTask).toHaveBeenCalledTimes(2);
  expect(f.captcha.pushVariable).toHaveBeenCalledWith("job-1", "answer", { text: "private-variable" }, expect.any(AbortSignal));
  expect(JSON.stringify(f.entries)).not.toMatch(/private-image|private-solution|private-variable/);
  expect(f.entries.some(entry => entry.payload.name === "workflow.captcha.create_task" && entry.payload.effect === true)).toBe(true);
});

it("retains CAPTCHA jobs across Python cells and exposes the API in compiled execution", async () => {
  const f = captchaFixture(), runner = testRunner().open!({ runId: "captcha-run", leaseGeneration: 1 });
  try {
    const tool = f.tool({ captcha: f.captcha, pythonRunner: runner });
    expect(await tool.execute({ source: "job = captcha.solve(provider='capsolver', task={'type': 'ImageToTextTask'}, idempotency_key='same-challenge', wait_ms=0)" })).toMatchObject({ ok: true });
    expect(await tool.execute({ source: "assert captcha.wait(job_id=job['id'], wait_ms=0)['status'] == 'ready'" })).toMatchObject({ ok: true });
    expect(f.captcha.createTask).toHaveBeenCalledOnce();
    expect(await f.tool({ captcha: f.captcha, compiled: true }).execute({ source: "def run(page, context, browser):\n    job = captcha.get_result(job_id='job-1')\n    browser.done(result=job['status'])" })).toMatchObject({ ok: true, terminal: { outcome: "done", result: "ready" } });
  } finally {
    await runner.close!();
  }
});

it("validates CAPTCHA arguments and rejects unavailable services before dispatch", async () => {
  const f = captchaFixture(), tool = f.tool({ captcha: f.captcha });
  for (const source of ["captcha.solve(provider='capsolver')", "captcha.wait(job_id='job-1', wait_ms=120001)"]) {
    expect(await tool.execute({ source })).toMatchObject({ ok: false });
  }
  expect(f.captcha.createTask).not.toHaveBeenCalled();
  expect(f.captcha.getResult).not.toHaveBeenCalled();
  expect(await f.tool().execute({ source: "assert 'captcha.solve' not in browser.describe()['services']\ncaptcha.providers()" })).toMatchObject({ ok: false, error: expect.stringContaining("Unavailable operation") });
});

it("checks browser control before CAPTCHA calls", async () => {
  const f = captchaFixture();
  let checks = 0;
  const tool = f.tool({ captcha: f.captcha, beforeCall: async () => ++checks > 1 });
  expect(await tool.execute({ source: "captcha.solve(provider='capsolver', task={'type':'ImageToTextTask'}, idempotency_key='challenge')" })).toMatchObject({ ok: false, error: expect.stringContaining("Browser control changed") });
  expect(f.captcha.createTask).not.toHaveBeenCalled();
});

it("passes the CAPTCHA model tool and Python API guidance to the loop's system prompt", async () => {
  const f = captchaFixture();
  const tools = buildBrowserCodeTools({ session: f.session, pythonRunner: testRunner(), captcha: f.captcha, emit: async () => ({ outcome: "deduped" }) });
  let request: LlmRequest | undefined;
  await runAgentLoop({ tools, task: { prompt: "finish" }, trigger: null, emits: [], trace: f.trace,
    llm: { complete: async input => {
      request = input;
      return { toolCalls: [{ id: "done", name: "browser.python", args: { source: "browser.done()" } }], usage: { in: 1, out: 1 } };
    } },
  });
  expect(request!.tools.some(tool => tool.name === "browser.captcha")).toBe(true);
  for (const method of ["providers", "create_task", "get_result", "wait", "solve", "push_variable"]) {
    expect(request!.system).toContain(`captcha.${method}(`);
  }
});
