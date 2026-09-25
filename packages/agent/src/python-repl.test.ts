import { afterEach, expect, it, vi } from "vitest";
import type { ProxyOptions } from "@tabductor/browser";
import { pythonFixture, testRunner, remoteRef } from "./python-test-support.js";
import type { PythonRunner } from "./python-runner.js";
import { readSdkEvidence } from "@tabductor/compiler";
import { validatePythonCandidate } from "./python-validation.js";

const runners: PythonRunner[] = [];
afterEach(async () => { await Promise.all(runners.splice(0).map(r => r.close?.())); });
function fixture(id = "repl") {
  const runner = testRunner().open!({ runId: id, leaseGeneration: 1 });
  runners.push(runner);
  const f = pythonFixture();
  return { ...f, runner, tool: f.tool({ pythonRunner: runner }) };
}

it("preserves variables, imports, functions, classes and assignments after an exception", async () => {
  const f = fixture();
  expect(f.tool.description).toContain("persistent Python REPL");
  expect(await f.tool.execute({ source: `import json
rows = [{'id': 1}]
class Counter:
    def __init__(self): self.value = 1
counter = Counter()
def add(value):
    rows.append({'id': value})
    counter.value += 1
raise ValueError('partial cell')` })).toMatchObject({ ok: false, error: expect.stringContaining("partial cell") });
  expect(await f.tool.execute({ source: "add(2)\nprint(json.dumps(rows))\nprint(counter.value)" })).toMatchObject({ ok: true, value: { output: '[{"id": 1}, {"id": 2}]\n2\n' } });
  expect(await f.tool.execute({ source: "rows = []\nif invalid syntax" })).toMatchObject({ ok: false, error: expect.stringContaining("Nothing was executed") });
  expect(await f.tool.execute({ source: "print(len(rows))" })).toMatchObject({ ok: true, value: { output: "2\n" } });
});

it("keeps browser objects in the same scope until the run closes", async () => {
  const f = fixture();
  const proxy = vi.fn(f.session.page.proxy!);
  f.session.page.proxy = proxy;
  expect(await f.tool.execute({ source: "field = page.locator('input')" })).toMatchObject({ ok: true });
  expect(await f.tool.execute({ source: "field.fill('retained locator')\nprint(field.count())" })).toMatchObject({ ok: true, value: { output: "1\n" } });
  expect(proxy.mock.calls.filter(([command]) => command.command === "open")).toHaveLength(1);
  expect(proxy.mock.calls.some(([command]) => command.command === "close")).toBe(false);
  expect(new Set(proxy.mock.calls.map(([, options]) => options.invocation)).size).toBe(1);
  await f.runner.close!();
  expect(proxy.mock.calls.filter(([command]) => command.command === "close")).toHaveLength(1);
});

it("preserves callbacks and records their registration across cells for replay", async () => {
  const f = fixture();
  let callback = "";
  const original = f.session.page.proxy!;
  f.session.page.proxy = async (command, options: ProxyOptions) => {
    if (command.call?.member === "on") callback = (command.call.args[1] as { $callback: string }).$callback;
    if (command.call?.member === "click") await options.callback!({ id: "cross-cell", callback, args: [], parentJob: command.call.operationId });
    return original(command, options);
  };
  const first = "values = []\ndef loaded():\n    values.append(page.title())\npage.on('load', loaded)\ntarget = page.locator('button')";
  const second = "if target.count() != 1: workflow.deopt(reason='target changed')\ntarget.click()\nprint(values)\nworkflow.done()";
  expect(await f.tool.execute({ source: first })).toMatchObject({ ok: true });
  expect(await f.tool.execute({ source: second })).toMatchObject({ ok: true, terminal: { outcome: "done" } });
  const evidence = readSdkEvidence({ runId: "repl-callback", entries: f.entries });
  expect(evidence.invocations[0]!.replSessionId).toBe(evidence.invocations[1]!.replSessionId);
  const operations = evidence.operations.filter(op => !op.name.startsWith("internal.") && op.name !== "playwright.open");
  const guard = operations.find(op => op.args.member === "count")!;
  const plan = { goal: "click", guards: [{ operationId: guard.operationId, condition: "one target" }],
    steps: operations.filter(op => op !== guard).map(op => ({ operationId: op.operationId, why: "required" })),
    bindings: [], discarded: [], recoveryPrompt: "Inspect" };
  const source = "def run(page, context, workflow):\n    try:\n" + (first + "\n" + second).split("\n").map(line => "        " + line).join("\n") + "\n    except Exception as error:\n        workflow.deopt(reason=str(error))";
  expect(await validatePythonCandidate(testRunner(), source, evidence, plan)).toEqual({ ok: true });
});

it("isolates separate runs and updates workflow.input without dropping user variables", async () => {
  const a = fixture("one"), b = fixture("two");
  expect(await a.tool.execute({ source: "private_value = 'run one'" })).toMatchObject({ ok: true });
  expect(await b.tool.execute({ source: "assert 'private_value' not in globals()" })).toMatchObject({ ok: true });
  const resumed = a.tool = pythonFixture().tool({ pythonRunner: a.runner, input: { id: "current" }, session: a.session });
  expect(await resumed.execute({ source: "assert private_value == 'run one'\nassert workflow.input['id'] == 'current'" })).toMatchObject({ ok: true });
});

it("keeps compiled-to-AI handoffs in the same interpreter", async () => {
  const f = fixture();
  const compiled = pythonFixture().tool({ pythonRunner: f.runner, compiled: true, session: f.session });
  expect(await compiled.execute({ source: "def run(page, context, workflow):\n    global selected\n    selected = page.locator('input')\n    workflow.deopt(reason='finish with AI')" })).toMatchObject({ ok: true, terminal: { outcome: "deopt" } });
  expect(await f.tool.execute({ source: "selected.fill('recovered')\nworkflow.done()" })).toMatchObject({ ok: true, terminal: { outcome: "done" } });
});

it("reports namespace loss after an interpreter reset and closes old browser scopes", async () => {
  const f = fixture();
  const proxy = vi.fn(f.session.page.proxy!);
  f.session.page.proxy = proxy;
  const first = await f.tool.execute({ source: "temporary = 42" });
  await f.runner.reset!();
  const second = await f.tool.execute({ source: "assert 'temporary' not in globals()\nprint('fresh')" });
  expect(second).toMatchObject({ ok: true, value: { replReset: true, output: "fresh\n" } });
  expect((first.value as { replSessionId: string }).replSessionId).not.toBe((second.value as { replSessionId: string }).replSessionId);
  expect(proxy.mock.calls.filter(([command]) => command.command === "close")).toHaveLength(1);
});

it("carries evidence redaction forward when sensitive values may remain in the REPL", async () => {
  const f = fixture();
  f.calls.mockImplementation(async call => call.member === "request" ? remoteRef("APIRequestContext") : null);
  const tool = pythonFixture().tool({ pythonRunner: f.runner, session: f.session, trace: f.trace, storageFlags: { network: false } });
  expect(await tool.execute({ source: "request = context.request\nrequest.get('/private')\nsecret = 'do-not-archive'" })).toMatchObject({ ok: true });
  expect(await tool.execute({ source: "page.evaluate('(value) => value', arg=secret)" })).toMatchObject({ ok: true });
  const second = f.entries.filter(entry => entry.payload.action === "sdk.invocation").at(-1)!;
  expect(second.payload.evidenceOmitted).toBe(true);
  expect(JSON.stringify(f.entries)).not.toContain("do-not-archive");
});
