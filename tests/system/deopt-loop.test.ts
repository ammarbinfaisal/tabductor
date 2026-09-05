import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { activateScript, insertCandidateScript } from "@tabductor/compiler";
import { tasks } from "@tabductor/db";
import { seedWorkflow, triggerTask } from "@tabductor/engine";
import { eq } from "drizzle-orm";
import { startAgentRig, traceRowsFor, type AgentRig } from "./agent-support.js";
import { eventsOfType, runsForTask, waitForQuiet } from "./engine-support.js";

/**
 * The handoff: guards fail, and the run does not.
 *
 * This is the half of the design that makes compilation safe to attempt at all. A compiled
 * script is a bet that the page still looks the way it did; `ctx.deopt` is what happens when
 * the bet loses, and the whole point is that the *run* continues — same row, same session,
 * same page — under the agent, with the compiler-authored recovery prompt as its briefing.
 * Without this, every site change would be a failed run instead of a slower one.
 */

const SCRIPT = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "scripts", "tweets-compiled.js"),
  "utf8",
);

let rig: AgentRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

it("guards fail on a changed layout, the agent finishes the same run, and the trace shows both", async () => {
  const outcomes: { deopted: boolean; ok: boolean }[] = [];
  rig = await startAgentRig({
    fixtureFor: () => "deopt-recovery.jsonl",
    compiled: {
      onOutcome: async ({ deopted, ok }) => {
        outcomes.push({ deopted, ok });
      },
    },
  });

  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Scrape: {
        mode: "ai",
        prompt: "Watch the timeline and report new tweets.",
        emits: ["tweet.detected"],
      },
    },
  });
  const taskId = wf.taskIds.Scrape!;
  // `compiled` is engine-assigned; flip the row the way promotion does.
  await rig.handle.db.update(tasks).set({ mode: "compiled" }).where(eq(tasks.id, taskId));

  // The compiled script points at the v2 layout, where its `article` guard cannot hold — the
  // site-redesign case, reproduced exactly.
  const source = SCRIPT.replaceAll("__FX_URL__", rig.fx.url).replace("/fake-tweets", "/mutator?layout=v2");
  const script = await insertCandidateScript(rig.handle.db, { taskId, source, fromRuns: ["run_a", "run_b"] });
  await activateScript(rig.handle.db, script.id);

  await triggerTask(rig.handle.db, { taskId });
  await waitForQuiet(rig as never);

  const runs = await runsForTask(rig as never, taskId);
  // One run row, not two: the deopt continued this run rather than failing it and retrying.
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status, runs[0]!.error ?? "").toBe("succeeded");
  // The run *was* a compiled run; what changed is that it needed help finishing.
  expect(runs[0]!.modeUsed).toBe("compiled");

  const rows = await traceRowsFor(rig, runs[0]!.id);
  const actions = rows
    .filter((r) => r.kind === "action")
    .map((r) => (r.payloadJson as { action: string }).action);

  // The order is the story: the script's own actions, then the deopt, then the agent's.
  expect(actions).toContain("deopt");
  expect(actions).toContain("deopt_recovery");
  const deoptAt = rows.findIndex((r) => (r.payloadJson as { action?: string }).action === "deopt");
  const firstLlmAt = rows.findIndex((r) => r.kind === "llm");
  expect(firstLlmAt).toBeGreaterThan(-1);
  expect(firstLlmAt).toBeGreaterThan(deoptAt);

  // The evidence the agent was handed is the guard failure, not a generic message.
  const deoptRow = rows[deoptAt]!;
  const evidence = (deoptRow.payloadJson as { evidence: { failed: { check: string }[] } }).evidence;
  expect(evidence.failed.map((f) => f.check)).toContain("exists");

  // The agent finished the job.
  expect((await eventsOfType(rig as never, "tweet.detected")).length).toBe(1);
  expect(outcomes).toEqual([{ deopted: true, ok: true }]);
}, 180_000);

/**
 * The cost claim, computable from stored data: a deopted run pays for the agent's turns, a
 * clean compiled run pays nothing. Both are visible in the same table.
 */
it("LLM cost lands on the deopted run and nowhere else", async () => {
  rig = await startAgentRig({ fixtureFor: () => "deopt-recovery.jsonl", compiled: {} });
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Scrape: { mode: "ai", prompt: "Watch the timeline.", emits: ["tweet.detected"] } },
  });
  const taskId = wf.taskIds.Scrape!;
  await rig.handle.db.update(tasks).set({ mode: "compiled" }).where(eq(tasks.id, taskId));
  const source = SCRIPT.replaceAll("__FX_URL__", rig.fx.url).replace("/fake-tweets", "/mutator?layout=v2");
  const script = await insertCandidateScript(rig.handle.db, { taskId, source, fromRuns: ["r"] });
  await activateScript(rig.handle.db, script.id);

  await triggerTask(rig.handle.db, { taskId });
  await waitForQuiet(rig as never);
  const deopted = (await runsForTask(rig as never, taskId))[0]!;
  const deoptedLlm = (await traceRowsFor(rig, deopted.id)).filter((r) => r.kind === "llm");
  expect(deoptedLlm.length).toBeGreaterThan(0);

  // Now the same task on the layout its script *was* compiled for: no model call at all.
  const clean = SCRIPT.replaceAll("__FX_URL__", rig.fx.url);
  const v2 = await insertCandidateScript(rig.handle.db, { taskId, source: clean, fromRuns: ["r2"] });
  await activateScript(rig.handle.db, v2.id);
  await triggerTask(rig.handle.db, { taskId });
  await waitForQuiet(rig as never);

  const runs = await runsForTask(rig as never, taskId);
  expect(runs).toHaveLength(2);
  const cleanRun = runs[1]!;
  expect(cleanRun.status, cleanRun.error ?? "").toBe("succeeded");
  expect((await traceRowsFor(rig, cleanRun.id)).filter((r) => r.kind === "llm")).toEqual([]);

  // Activating v2 retired v1 — the invariant the partial unique index enforces.
  const [taskAfter] = await rig.handle.db.select().from(tasks).where(eq(tasks.id, taskId));
  expect(taskAfter?.mode).toBe("compiled");
}, 180_000);
