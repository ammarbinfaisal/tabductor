import { afterEach, expect, it } from "vitest";
import { seedWorkflow, updateTask } from "@tabductor/engine";
import { runsForTask, trigger, waitFor, waitForQuiet } from "./engine-support.js";
import { startAgentRig, waitForTraceRows, type AgentRig } from "./agent-support.js";

/**
 * S4b spec §6, fourth bullet: a transcript that never calls `done`/`fail` exhausts
 * `limits_json.agent.max_steps` and fails `step_budget_exceeded`, trace intact. Fixture
 * `fixtures/transcripts/step-budget.jsonl` has exactly 3 turns — the task's `max_steps` is
 * set to 3 below so the loop asks the replay adapter for precisely as many completions as
 * the fixture has, and no more (a 4th call would throw `llm_replay_exhausted`, which would
 * itself be a bug in this test, not the thing under test).
 */

let rig: AgentRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

it("never calling done/fail exhausts max_steps and fails step_budget_exceeded, trace intact", async () => {
  rig = await startAgentRig({ fixtureFor: () => "step-budget.jsonl" });

  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Scrape: { mode: "ai", prompt: "Scroll around forever.", consumes: ["work.requested"] },
    },
  });
  await updateTask(rig.handle.db, {
    taskId: wf.taskIds.Scrape!,
    limits: { agent: { max_steps: 3 } },
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");
  await waitFor("Scrape's run to fail", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Scrape!);
    return row?.status === "failed" ? row : false;
  });
  await waitForQuiet(rig);

  const attempts = await runsForTask(rig, wf.taskIds.Scrape!);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.error).toBe("step_budget_exceeded");

  const rows = await waitForTraceRows(rig, attempts[0]!.id, (r) => r.filter((x) => x.kind === "llm").length >= 3);
  expect(rows.filter((r) => r.kind === "llm").length).toBe(3);
  expect(
    rows.some(
      (r) => (r.payloadJson as { action?: string }).action === "agent.step_budget_exceeded",
    ),
  ).toBe(true);
});
