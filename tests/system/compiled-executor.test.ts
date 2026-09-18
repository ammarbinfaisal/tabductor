import { SCRIPT_RUNTIME_VERSION } from "@tabductor/core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  activateScript,
  insertCandidateScript,
  noteAiRun,
  promoteTask,
  recordCompiledRun,
} from "@tabductor/compiler";
import { compiledScripts, tasks } from "@tabductor/db";
import { seedWorkflow, triggerTask, updateTask } from "@tabductor/engine";
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
        mode: "ai",
        prompt: "Watch the timeline and report new tweets.",
        emits: ["tweet.detected"],
      },
    },
  });
  const taskId = wf.taskIds.Scrape!;
  const script = await insertCandidateScript(rig!.handle.db, {
    taskId,
    guardsMeta: { compatibility: { browserVersion: rig!.chrome.version, runtimeVersion: SCRIPT_RUNTIME_VERSION } },
    source: SCRIPT.replaceAll("__FX_URL__", rig!.fx.url),
    fromRuns: ["run_a", "run_b"],
  });
  await activateScript(rig!.handle.db, script.id);
  // `compiled` is engine-assigned (`checkGraph` refuses it in a document), so the row is
  // flipped the way promotion flips it rather than published that way.
  await rig!.handle.db.update(tasks).set({ mode: "compiled" }).where(eq(tasks.id, taskId));
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
    tasks: { Scrape: { mode: "ai", retry: { max: 2, backoff_ms: 10 } } },
  });
  const taskId = wf.taskIds.Scrape!;
  await rig.handle.db.update(tasks).set({ mode: "compiled" }).where(eq(tasks.id, taskId));

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
 * Promotion, tested as policy — and as *two* steps, which is the S6e shape. A run only makes
 * the task **eligible**; the script is activated later, by the compile worker, against the task
 * content the job was queued for. The cases worth asserting are the ones a naive counter gets
 * wrong: a failed run, a kind that is never compiled, and a task edited mid-compile.
 */
it("the first clean ai run makes the task eligible, and promotion activates the script", async () => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, { tasks: { Scrape: { mode: "ai", emits: ["tweet.detected"] } } });
  const taskId = wf.taskIds.Scrape!;
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

  const script = await insertCandidateScript(db, { taskId, source: "// compiled", fromRuns: ["a"] });
  const eligibility = await noteAiRun({ db }, await taskRow(), { ok: true });
  expect(eligibility.eligible).toBe(true);

  const promotion = await promoteTask(
    { db },
    { taskId, scriptId: script.id, expectContentHash: (await taskRow()).contentHash },
  );
  expect(promotion.promoted).toBe(true);

  const after = await taskRow();
  expect(after.mode).toBe("compiled");
  // The counter resets, so a demotion later starts the climb again rather than re-promoting
  // on the strength of runs from before.
  expect(after.cleanAiRuns).toBe(0);
  const [row] = await db.select().from(compiledScripts).where(eq(compiledScripts.id, script.id));
  expect(row?.status).toBe("active");
}, 120_000);

it("a failed ai run is not eligible and resets the counter", async () => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, { tasks: { Scrape: { mode: "ai" } } });
  const taskId = wf.taskIds.Scrape!;
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

  const result = await noteAiRun({ db }, await taskRow(), { ok: false });
  expect(result).toEqual({ eligible: false, cleanRuns: 0, reason: "run failed" });
  expect((await taskRow()).cleanAiRuns).toBe(0);
  expect((await taskRow()).mode).toBe("ai");
}, 120_000);

/**
 * The artifact has to match the task content it implements (graph-compilation-llm §6.3).
 * Compilation is long; an author who edits the node while it runs must not get a script
 * compiled from the definition they just replaced.
 */
it("a task edited while its trace was compiling is not promoted", async () => {
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, { tasks: { Scrape: { mode: "ai", prompt: "Watch the timeline." } } });
  const taskId = wf.taskIds.Scrape!;
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

  const script = await insertCandidateScript(db, { taskId, source: "// compiled", fromRuns: ["a"] });
  const hashAtEnqueue = (await taskRow()).contentHash;
  await updateTask(db, { taskId, prompt: "Watch the timeline, and also the replies." });

  const promotion = await promoteTask({ db }, { taskId, scriptId: script.id, expectContentHash: hashAtEnqueue });
  expect(promotion.promoted).toBe(false);
  expect(promotion.reason).toContain("changed");
  expect((await taskRow()).mode).toBe("ai");
  const [row] = await db.select().from(compiledScripts).where(eq(compiledScripts.id, script.id));
  expect(row?.status).toBe("candidate");
}, 120_000);

/** Decision tasks remain semantic and must not accumulate toward browser-script promotion. */
it("a decision task never advances the promotion counter", async () => {
  const kind = "decision" as const;
  rig = await startAgentRig({ compiled: {}, fixtureFor: () => "compiled-tweets-script.jsonl" });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, { tasks: { T: { kind, mode: "ai" } } });
  const taskId = wf.taskIds.T!;
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

  for (let i = 0; i < 2; i++) {
    const out = await noteAiRun({ db }, await taskRow(), { ok: true });
    expect(out.eligible).toBe(false);
    expect(out.reason).toBe(`kind ${kind} is never compiled`);
  }
  expect((await taskRow()).cleanAiRuns).toBe(0);
  expect((await taskRow()).mode).toBe("ai");
}, 120_000);

it.each(["missing", "browser", "runtime"])("demotes %s compatibility before running any compiled browser action", async (mismatch) => {
  let modelCalls = 0;
  rig = await startAgentRig({ compiled: {}, llmFor: () => ({ complete: async () => {
    modelCalls++;
    return { toolCalls: [{ id: "finish", name: "done", args: {} }], usage: { in: 0, out: 0 } };
  } }) });
  const { taskId, scriptId } = await compiledTask();
  await rig.handle.db.update(compiledScripts).set({ guardsMeta: mismatch === "missing" ? {} : {
    compatibility: { browserVersion: mismatch === "browser" ? "old-browser" : rig.chrome.version,
      runtimeVersion: mismatch === "runtime" ? "old-runtime" : SCRIPT_RUNTIME_VERSION },
  } }).where(eq(compiledScripts.id, scriptId));
  await triggerTask(rig.handle.db, { taskId });
  await waitForQuiet(rig as never);
  const runs = await runsForTask(rig as never, taskId);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status).toBe("succeeded");
  expect(modelCalls).toBe(1);
  expect(await eventsOfType(rig as never, "tweet.detected")).toEqual([]);
  const rows = await traceRowsFor(rig, runs[0]!.id);
  expect(rows.some((row) => (row.payloadJson as { action?: string }).action === "goto")).toBe(false);
  expect(rows.some((row) => (row.payloadJson as { trigger?: string }).trigger === "runtime_incompatible")).toBe(true);
  expect((await rig.handle.db.select().from(compiledScripts).where(eq(compiledScripts.id, scriptId)))[0]!.status).toBe("invalidated");
  expect((await rig.handle.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.mode).toBe("ai");
}, 120_000);
