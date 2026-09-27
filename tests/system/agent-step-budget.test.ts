import { afterEach, expect, it } from "vitest";
import { triggerTask } from "@tabductor/engine";
import { seedWorkflow } from "@tabductor/engine/testing";
import { runsForTask, waitForQuiet } from "./engine-support.js";
import { startAgentRig, waitForTraceRows, type AgentRig } from "./agent-support.js";

/** AI runs continue past both the former default and legacy per-task step caps. */

let rig: AgentRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

it.each([undefined, 3])("finishes beyond 30 model turns with legacy max_steps=%s", async (maxSteps) => {
  let turns = 0;
  rig = await startAgentRig({ llmFor: ({ trace }) => ({ async complete() {
    turns++;
    await trace.record("llm", { turn: turns });
    return { usage: { in: 1, out: 1 }, toolCalls: turns <= 40
      ? [{ id: `read-${turns}`, name: "browser.code", args: {source:"export default async api => api.page.perceive({})"} }]
      : [{ id: "finish", name: "browser.code", args: {source:"export default async api => { await api.page.verify({urlIncludes:'about:blank'}); return api.run.done({result:'finished'}); }"} }] };
  } }) });

  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Scrape: { mode: "ai", prompt: "Observe the current page, then finish.",
        limits: maxSteps === undefined ? {} : { agent: { max_steps: maxSteps } } },
    },
  });
  await triggerTask(rig.handle.db, { taskId: wf.taskIds.Scrape! });
  await waitForQuiet(rig);

  const attempts = await runsForTask(rig, wf.taskIds.Scrape!);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.status, attempts[0]!.error ?? "").toBe("succeeded");
  expect(turns).toBe(41);

  const rows = await waitForTraceRows(rig, attempts[0]!.id, (r) => r.filter((x) => x.kind === "llm").length >= 41);
  expect(rows.filter((r) => r.kind === "llm").length).toBe(41);
  expect(
    rows.some(
      (r) => (r.payloadJson as { action?: string }).action === "agent.step_budget_exceeded",
    ),
  ).toBe(false);
  expect(rows.some(row => (row.payloadJson as { action?: string; steps?: number }).action === "agent.done" &&
    (row.payloadJson as { steps?: number }).steps === 41)).toBe(true);
});
