import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchChrome } from "@tabductor/testkit";
import { openRunSession, playwrightDriver } from "@tabductor/browser";
import { AllowAllGate } from "@tabductor/policy";
import { buildToolRegistry, liveLlm, runAgentLoop } from "@tabductor/agent";

// This incident used gpt-5.6-luna. Keep that model fixed while evaluating the harness.
// No external website or account is modified: the browser only visits this local fixture.
it.skipIf(!process.env.OPENAI_API_KEY)("prepares a property in a delayed editor without an open/close loop", async () => {
  const html = readFileSync(new URL("../../apps/browser-worker/tests/fixtures/property-editor.html", import.meta.url));
  const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chrome = await launchChrome();
  const conn = await playwrightDriver.connect(chrome.wsUrl);
  const events: Array<Record<string, unknown>> = [];
  const trace = { record: async (_kind: string, payload: Record<string, unknown>) => { events.push(payload); }, flush: async () => {}, close: async () => {} };
  const session = await openRunSession({ conn, trace, taskCtx: { runId: "fixture", taskId: "property" }, gate: new AllowAllGate({ navAllowlist: ["127.0.0.1"] }) });
  let journal: unknown = [];
  const actions = { get: async () => journal, set: async (value: unknown) => { journal = value; } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    await session.page.goto(origin);
    const result = await runAgentLoop({
      llm: liveLlm({ provider: "openai", apiKey: process.env.OPENAI_API_KEY!, model: "gpt-5.6-luna" }),
      tools: buildToolRegistry({ session, actions, trace, signal: controller.signal, emit: async () => ({ outcome: "deduped" }) }),
      task: { prompt: "Add a property named username to this table. Preserve the existing Name property and avoid duplicates. Verify the new property is visible after closing its editor, then finish." },
      actions, initialPerception: () => session.page.perceive(), trigger: null, emits: [], trace, signal: controller.signal,
    });
    expect(result.outcome).toBe("done");
    const page = await session.page.perceive();
    expect(page.activeScope).toBe("page");
    expect(await session.page.queryAll("#properties span", { name: {} })).toEqual([{ name: "username" }]);
    expect(events.some(e => e.action === "interaction.cycle")).toBe(false);
  } finally {
    clearTimeout(timer);
    await session.close(); await conn.close(); await chrome.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
