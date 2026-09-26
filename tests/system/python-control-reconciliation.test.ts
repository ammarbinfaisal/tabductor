import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createCamoufoxWorkerDriver, type RunSession } from "@tabductor/browser";
import { localPythonRunnerForTest } from "@tabductor/agent";
import { pythonTool } from "../../packages/agent/src/python-tool.js";

it.skipIf(!process.env.CAMOUFOX_TEST_URL)("keeps a Python cell alive across fleet updates and cancels it on real takeover", async () => {
  const workerUrl = process.env.CAMOUFOX_TEST_URL!;
  const token = process.env.CAMOUFOX_TEST_TOKEN ?? "harness-fixture-token";
  const sessionId = "control-reconciliation-fixture";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-tabductor-rpc-version": "1" };
  const started = await fetch(`${workerUrl}/v1/sessions`, { method: "POST", headers,
    body: JSON.stringify({ session_id: sessionId, generation: 1, profile_dir: sessionId }) });
  expect(started.status, await started.text()).toBe(200);
  let generation = 1, evaluationStarts = 0;
  let onEvaluationStarted: (() => void) | undefined;
  const conn = await createCamoufoxWorkerDriver({ token, sessionId, generation: 1,
    fetch: async (url, init) => {
      const command = JSON.parse(String(init?.body));
      const response = await fetch(url, { ...init, body: JSON.stringify({ ...command, input_generation: generation }) });
      if (response.ok && command.method === "start" && command.params.member === "evaluate") {
        evaluationStarts++;
        onEvaluationStarted?.();
      }
      return response;
    },
  }).connect(workerUrl);
  const control = async (owner: string, inputGeneration: number) => {
    const response = await fetch(`${workerUrl}/v1/sessions/${sessionId}/control`, { method: "POST", headers,
      body: JSON.stringify({ generation: 1, input_generation: inputGeneration, owner }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ acknowledged: true, input_generation: inputGeneration });
  };
  try {
    const page = await conn.createPage();
    let progress: unknown = {};
    const tool = pythonTool({ session: { page } as RunSession, emit: async () => ({ outcome: "deduped" }),
      progress: { get: async () => progress, set: async value => { progress = value; } },
      pythonRunner: localPythonRunnerForTest(fileURLToPath(new URL("../../vendor/browser-harness/src/browser_harness/tabductor_runner.py", import.meta.url))) });
    let ready = new Promise<void>(resolve => { onEvaluationStarted = resolve; });
    const first = tool.execute({ source: "print(page.evaluate('() => { window.effects = (window.effects || 0) + 1; return new Promise(resolve => setTimeout(() => resolve(window.effects), 1500)); }'))\nassert page.evaluate('() => window.effects') == 1" });
    await ready;
    for (let i = 0; i < 5; i++) {
      await control("ai", 1);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(await first).toMatchObject({ ok: true });
    expect(evaluationStarts).toBe(2);

    ready = new Promise<void>(resolve => { onEvaluationStarted = resolve; });
    const second = tool.execute({ source: "page.evaluate('() => new Promise(resolve => setTimeout(resolve, 10000))')" })
      .catch(error => ({ ok: false, error: String(error), code: error.code }));
    await ready;
    await control("paused", 2);
    // A cancelled effect must be reported, never silently submitted again.
    const cancelled = await second;
    expect(cancelled).toMatchObject({ ok: false });
    expect(JSON.stringify(cancelled)).toMatch(/browser_input_revoked|cancelled|invocation expired/);
    expect(progress).toMatchObject({ requiresReconciliation: true });
    expect(evaluationStarts).toBe(3);
    generation = 3;
    await control("ai", generation);
    expect(await tool.execute({ source: "assert page.evaluate('() => window.effects') == 1" })).toMatchObject({ ok: true });
  } finally {
    await conn.close();
    await fetch(`${workerUrl}/v1/sessions/${sessionId}?generation=1`, { method: "DELETE", headers });
  }
}, 60000);
