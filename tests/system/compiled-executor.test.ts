import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  activateScript,
  insertCandidateScript,
  recordAiRun,
  recordCompiledRun,
} from "@tabductor/compiler";
import { compiledScripts, tasks } from "@tabductor/db";
import { seedWorkflow, triggerTask } from "@tabductor/engine";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { startAgentRig, traceRowsFor, type AgentRig } from "./agent-support.js";
import { eventsOfType, runsForTask, waitForQuiet } from "./engine-support.js";

/**
 * The fast path, end to end through the real engine.
 *
 * The assertion that matters is an **absence**: a clean compiled run leaves a trace with zero
 * `llm` entries. That is the product's core claim — "steady-state runs make no model calls" —
 * and it is checked rather than assumed, because nothing else in the system would notice if a
 * model call crept back in.
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

/** A task already in `compiled` mode with `SCRIPT` active — the state promotion produces. */
async function compiledTask(): Promise<{ taskId: string; scriptId: string }> {
  const wf = await seedWorkflow(rig!.handle.db, {
    tasks: {
      Scrape: {
        mode: "compiled",
        prompt: "Watch the timeline and report new tweets.",
        emits: ["tweet.detected"],
      },
    },
  });
  const taskId = wf.taskIds.Scrape!;
  const script = await insertCandidateScript(rig!.handle.db, {
    taskId,
    source: SCRIPT.replaceAll("__FX_URL__", rig!.fx.url),
    fromRuns: ["run_a", "run_b"],
  });
  await activateScript(rig!.handle.db, script.id);
  return { taskId, scriptId: script.id };
}

it("a compiled run drives the page, emits, and makes zero LLM calls", async () => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const { taskId } = await compiledTask();

  // The script navigates itself, so the run needs nothing but a trigger.
  await rig.handle.db
    .update(tasks)
    .set({ limitsJson: {} })
    .where(eq(tasks.id, taskId));
  await triggerTask(rig.handle.db, { taskId });
  await waitForQuiet(rig as never);

  const runs = await runsForTask(rig as never, taskId);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status, runs[0]!.error ?? "").toBe("succeeded");
  expect(runs[0]!.modeUsed).toBe("compiled");

  const rows = await traceRowsFor(rig, runs[0]!.id);
  // The claim, as an absence.
  expect(rows.filter((r) => r.kind === "llm")).toEqual([]);
  // And a positive control, so the absence is not just an empty trace.
  const actions = rows.filter((r) => r.kind === "action").map((r) => (r.payloadJson as { action: string }).action);
  expect(actions).toContain("queryAll");
  expect(actions).toContain("emit");

  const emitted = await eventsOfType(rig as never, "tweet.detected");
  expect(emitted.length).toBeGreaterThan(0);
}, 180_000);

it("a second run against an unchanged page emits nothing — emitIfNew holds across runs", async () => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const { taskId } = await compiledTask();

  await triggerTask(rig.handle.db, { taskId });
  await waitForQuiet(rig as never);
  const first = (await eventsOfType(rig as never, "tweet.detected")).length;
  expect(first).toBeGreaterThan(0);

  await triggerTask(rig.handle.db, { taskId });
  await waitForQuiet(rig as never);
  const second = (await eventsOfType(rig as never, "tweet.detected")).length;

  // The dedupe claim rides `task_state`, which is per task and not per run.
  expect(second).toBe(first);
  const runs = await runsForTask(rig as never, taskId);
  expect(runs).toHaveLength(2);
  expect(runs.every((r) => r.status === "succeeded")).toBe(true);
}, 180_000);

it("a task in compiled mode with no active script fails permanently rather than retrying", async () => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Scrape: { mode: "compiled", retry: { max: 2, backoff_ms: 10 } } },
  });
  const taskId = wf.taskIds.Scrape!;

  await triggerTask(rig.handle.db, { taskId });
  await waitForQuiet(rig as never);

  const runs = await runsForTask(rig as never, taskId);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status).toBe("failed");
  expect(runs[0]!.error).toContain("no active compiled script");
}, 120_000);

/**
 * Demotion is policy, tested directly rather than by driving ten real runs: the rule is "3
 * deopts within the last 10", and the interesting cases are the boundary and the window
 * sliding, neither of which a browser adds anything to.
 */
it("demotes after 3 deopts in the last 10 runs, invalidating the active script", async () => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const { taskId, scriptId } = await compiledTask();
  const db = rig.handle.db;
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

  // Two deopts and plenty of clean runs: under the threshold, still compiled.
  for (const deopted of [true, false, false, true, false]) {
    const out = await recordCompiledRun({ db }, await taskRow(), { deopted });
    expect(out.demoted).toBe(false);
  }
  expect((await taskRow()).mode).toBe("compiled");

  const third = await recordCompiledRun({ db }, await taskRow(), { deopted: true });
  expect(third).toEqual({ demoted: true, deoptsInWindow: 3 });

  const after = await taskRow();
  expect(after.mode).toBe("ai");
  expect(after.recentDeopts).toEqual([]);
  const [script] = await db.select().from(compiledScripts).where(eq(compiledScripts.id, scriptId));
  expect(script?.status).toBe("invalidated");
}, 120_000);

it("deopts older than the window stop counting", async () => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const { taskId } = await compiledTask();
  const db = rig.handle.db;
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

  // Two deopts, then ten clean runs pushes them out of the window entirely.
  for (const deopted of [true, true, ...Array<boolean>(10).fill(false)]) {
    await recordCompiledRun({ db }, await taskRow(), { deopted });
  }
  const out = await recordCompiledRun({ db }, await taskRow(), { deopted: true });
  expect(out).toEqual({ demoted: false, deoptsInWindow: 1 });
  expect((await taskRow()).mode).toBe("compiled");
}, 120_000);

/**
 * Promotion, tested as policy. §11's rule is two *consecutive clean consistent* `ai` runs, and
 * the cases worth asserting are the ones where a naive counter gets it wrong: a failure in
 * between, and two successes that did different things.
 */
it("promotes after two consecutive clean consistent ai runs, activating the compiled script", async () => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, { tasks: { Scrape: { mode: "ai", emits: ["tweet.detected"] } } });
  const taskId = wf.taskIds.Scrape!;
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

  const script = await insertCandidateScript(db, { taskId, source: "// compiled", fromRuns: ["a", "b"] });
  const compile = async () => ({ ok: true as const, scriptId: script.id });

  const first = await recordAiRun({ db, compile }, await taskRow(), { ok: true, consistent: true });
  expect(first).toEqual({ promoted: false, reason: "1/2 clean runs" });
  expect((await taskRow()).mode).toBe("ai");

  const second = await recordAiRun({ db, compile }, await taskRow(), { ok: true, consistent: true });
  expect(second).toEqual({ promoted: true, scriptId: script.id });

  const after = await taskRow();
  expect(after.mode).toBe("compiled");
  // The counter resets, so a demotion later starts the climb again rather than re-promoting
  // on the strength of runs from before.
  expect(after.cleanAiRuns).toBe(0);
  const [row] = await db.select().from(compiledScripts).where(eq(compiledScripts.id, script.id));
  expect(row?.status).toBe("active");
}, 120_000);

it.each([
  ["a failed run", { ok: false, consistent: true }, "run failed"],
  ["two runs that did different things", { ok: true, consistent: false }, "runs diverged"],
])("%s resets the streak rather than counting toward promotion", async (_label, input, reason) => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, { tasks: { Scrape: { mode: "ai" } } });
  const taskId = wf.taskIds.Scrape!;
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  const compile = async () => {
    throw new Error("promotion must not have been attempted");
  };

  await recordAiRun({ db, compile }, await taskRow(), { ok: true, consistent: true });
  expect((await taskRow()).cleanAiRuns).toBe(1);

  const result = await recordAiRun({ db, compile }, await taskRow(), input);
  expect(result).toEqual({ promoted: false, reason });
  expect((await taskRow()).cleanAiRuns).toBe(0);
  expect((await taskRow()).mode).toBe("ai");
}, 120_000);

/** The §4 boundary again: an asset task must not accumulate toward a promotion S6b would refuse. */
it.each(["asset", "decision"] as const)("a %s task never advances the promotion counter", async (kind) => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, { tasks: { T: { kind, mode: "ai" } } });
  const taskId = wf.taskIds.T!;
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  const compile = async () => {
    throw new Error("promotion must not have been attempted");
  };

  for (let i = 0; i < 3; i++) {
    const out = await recordAiRun({ db, compile }, await taskRow(), { ok: true, consistent: true });
    expect(out).toEqual({ promoted: false, reason: `kind ${kind} is never compiled` });
  }
  expect((await taskRow()).cleanAiRuns).toBe(0);
  expect((await taskRow()).mode).toBe("ai");
}, 120_000);
