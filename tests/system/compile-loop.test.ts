import { afterEach, expect, it } from "vitest";
import { compiledScripts, tasks } from "@tabductor/db";
import { seedWorkflow, triggerTask } from "@tabductor/engine";
import { eq } from "drizzle-orm";
import { startAgentRig, traceRowsFor, type AgentRig } from "./agent-support.js";
import { runsForTask, waitFor, waitForQuiet } from "./engine-support.js";

/**
 * The loop, closed: the product's cost curve as one test.
 *
 * S6c's flagship drove the compiled executor with a script a test had shelved by hand. This
 * is the wiring that makes the shelf fill itself — `createCompileLoop` hangs off the agent
 * executor's `onOutcome`, and after the **first** clean `ai` run (K=1) the task's own trace is
 * compiled, dry-run, activated and the task promoted. The second trigger of the same task then
 * runs under `(browser, compiled)` and leaves a trace with zero `llm` rows.
 *
 * Nothing in this file inserts a script or flips a mode. The engine does both.
 */

let rig: AgentRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

it("the first clean ai run compiles the task, and the next run is compiled with zero model calls", async () => {
  rig = await startAgentRig({
    fixtureFor: () => "canonical-fake-tweets.jsonl",
    compileLoop: { compilerFixture: "compiler-tweets-goto.jsonl" },
  });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, {
    tasks: {
      Scrape: { mode: "ai", prompt: "Watch the timeline and report new tweets.", emits: ["tweet.detected"] },
    },
  });
  const taskId = wf.taskIds.Scrape!;
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

  // Run 1: the agent, replayed. Its trace is the compiler's input.
  await triggerTask(db, { taskId });
  await waitForQuiet(rig as never);
  const first = (await runsForTask(rig as never, taskId))[0]!;
  expect(first.status, first.error ?? "").toBe("succeeded");
  expect(first.modeUsed).toBe("ai");
  expect((await traceRowsFor(rig, first.id)).filter((r) => r.kind === "llm").length).toBeGreaterThan(0);

  // Promotion happened inside the run's own executor, before the row settled: no waiting.
  const promoted = await taskRow();
  expect(promoted.mode).toBe("compiled");
  const scripts = await db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId));
  expect(scripts).toHaveLength(1);
  expect(scripts[0]!.status).toBe("active");
  // Provenance: compiled from exactly the run that just finished.
  expect(scripts[0]!.fromRuns).toEqual([first.id]);

  // Run 2: the fast path. Same task, same page — and not one model call.
  await triggerTask(db, { taskId });
  await waitFor("the second run to exist", async () => (await runsForTask(rig as never, taskId)).length >= 2, 30_000);
  await waitForQuiet(rig as never);
  const runs = await runsForTask(rig as never, taskId);
  expect(runs).toHaveLength(2);
  const second = runs[1]!;
  expect(second.status, second.error ?? "").toBe("succeeded");
  expect(second.modeUsed).toBe("compiled");
  expect((await traceRowsFor(rig, second.id)).filter((r) => r.kind === "llm")).toEqual([]);
  // Still compiled, still one script: a clean compiled run neither recompiles nor demotes.
  expect((await taskRow()).mode).toBe("compiled");
  expect(await db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId))).toHaveLength(1);
}, 240_000);

/** A failed ai run compiles nothing: the shelf stays empty and the task stays `ai`. */
it("a failed ai run does not compile", async () => {
  rig = await startAgentRig({
    fixtureFor: () => "step-budget.jsonl",
    compileLoop: { compilerFixture: "compiler-tweets-goto.jsonl" },
  });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, {
    tasks: { Scrape: { mode: "ai", prompt: "Never finish.", emits: ["tweet.detected"], limits: { agent: { max_steps: 2 } } } },
  });
  const taskId = wf.taskIds.Scrape!;

  await triggerTask(db, { taskId });
  await waitForQuiet(rig as never);
  const run = (await runsForTask(rig as never, taskId))[0]!;
  expect(run.status).not.toBe("succeeded");

  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  expect(row?.mode).toBe("ai");
  expect(await db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId))).toHaveLength(0);
}, 120_000);
