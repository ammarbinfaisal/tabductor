import { expect, it } from "vitest";
import type { RunSession } from "@tabductor/browser";
import { GRAPH_AUTHORING_SYSTEM_PROMPT } from "../../engine/src/graph-authoring-prompts.js";
import { PROMPT_SYSTEM_PROMPT, TOOL_SURFACE } from "../../engine/src/prompt-compiler.js";
import { BROWSER_LEARNING_INSTRUCTIONS } from "./learning-evidence.js";
import { PYTHON_BROWSER_GUIDANCE } from "./python-guidance.js";
import { buildToolRegistry } from "./tools.js";
import { pythonFixture } from "./python-test-support.js";

const retired = ["checkpoint.get", "checkpoint.set", "code.status", "page.verify", "harness.verify"];

it("removes retired APIs from the registry and nested JavaScript catalog", async () => {
  const store = { get: async () => ({}), set: async () => {} };
  const tools = buildToolRegistry({ session: { page: { harness: async () => null } } as unknown as RunSession,
    emit: async () => ({ outcome: "deduped" }), checkpoint: store, progress: store });
  for (const name of retired) {
    expect(tools.some(tool => tool.name === name)).toBe(false);
    expect(tools.map(tool => tool.description).join("\n")).not.toContain(name);
    expect(await tools.find(tool => tool.name === "browser.code")!.execute({
      source: `export default async api => api.call(${JSON.stringify(name)}, {})`,
    })).toMatchObject({ ok: false, error: expect.stringContaining("unavailable") });
  }
});

it("removes the concepts from generated prompt instructions", () => {
  for (const prompt of [GRAPH_AUTHORING_SYSTEM_PROMPT, PROMPT_SYSTEM_PROMPT,
    PYTHON_BROWSER_GUIDANCE, BROWSER_LEARNING_INSTRUCTIONS, JSON.stringify(TOOL_SURFACE)]) {
    expect(prompt).not.toMatch(/checkpoint|operation progress|workflow\.status|code\.status|verification|record\.verify|verified-saves/i);
  }
});

it("does not advertise or expose retired Python workflow services", async () => {
  const tool = pythonFixture().tool();
  expect(tool.description).not.toMatch(/checkpoint|workflow\.status|record\.verify|verification/i);
  expect(await tool.execute({ source: `names = workflow.describe()['workflow']
assert not any('checkpoint' in name or name in ['workflow.status', 'workflow.record.verify'] for name in names)
for name in ['checkpoint', 'checkpoint_files', 'status']:
    assert not hasattr(workflow, name)
assert not hasattr(workflow.record, 'verify')
workflow.done()` })).toMatchObject({ ok: true, terminal: { outcome: "done" } });
});

it.each(["workflow.checkpoint.get()", "workflow.checkpoint.set(value={})", "workflow.status()", "workflow.record.verify()", "workflow.checkpoint_files()"])(
  "rejects retired Python service %s", async source => {
    expect(await pythonFixture().tool().execute({ source })).toMatchObject({ ok: false, error: expect.stringContaining("Unknown workflow method") });
  });

it.each([false, true])("permits task completion without a verification call (compiled: %s)", async compiled => {
  const body = "page.locator('input').fill('current value')\nworkflow.done(result='finished')";
  const source = compiled ? "def run(page, context, workflow):\n" + body.split("\n").map(line => "    " + line).join("\n") : body;
  expect(await pythonFixture().tool({ compiled }).execute({ source })).toMatchObject({ ok: true, terminal: { outcome: "done", result: "finished" } });
});
