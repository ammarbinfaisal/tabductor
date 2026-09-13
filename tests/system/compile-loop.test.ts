import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { activateScript, insertCandidateScript } from "@tabductor/compiler";
import { cdpEndpoints, compileJobs, compiledScripts, tasks } from "@tabductor/db";
import { seedWorkflow, triggerTask } from "@tabductor/engine";
import { eq } from "drizzle-orm";
import { startAgentRig, traceRowsFor, type AgentRig } from "./agent-support.js";
import { eventsOfType, runsForTask, waitFor, waitForQuiet } from "./engine-support.js";

/**
 * The loop, closed — and, from S6e, closed *behind* the run rather than inside it.
 *
 * The order this test asserts is the contract (`docs/trace-compilation.md`): the agent run
 * finishes and settles, still in mode `ai`, having done nothing but leave a queue row behind.
 * Only then does a separate compilation task read its trace, distil the work, validate a
 * candidate in isolation and promote the task. The next trigger runs the script, with zero
 * model calls.
 *
 * Nothing in this file inserts a script or flips a mode. The engine and the worker do both.
 */

let rig: AgentRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

const jobsFor = (r: AgentRig, taskId: string) =>
  r.handle.db.select().from(compileJobs).where(eq(compileJobs.taskId, taskId));

it("the run settles first, then a separate compile promotes the task, and the next run makes no model call", async () => {
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

  // Run 1: the agent, replayed.
  await triggerTask(db, { taskId });
  await waitForQuiet(rig as never);
  const first = (await runsForTask(rig as never, taskId))[0]!;
  expect(first.status, first.error ?? "").toBe("succeeded");
  expect(first.modeUsed).toBe("ai");
  expect((await traceRowsFor(rig, first.id)).filter((r) => r.kind === "llm").length).toBeGreaterThan(0);
  expect((await eventsOfType(rig as never, "tweet.detected")).length).toBe(3);

  // The run is over and nothing has been compiled: the hook wrote a queue row and got out of
  // the way. This is the assertion S6d could not make — compilation used to happen inside the
  // executor's `finally`, before the engine settled the run.
  expect((await taskRow()).mode).toBe("ai");
  expect(await db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId))).toHaveLength(0);
  const [queued] = await jobsFor(rig, taskId);
  expect(queued).toMatchObject({ status: "queued", reason: "promote", runId: first.id, attempts: 0 });

  // Compilation needs no browser at all: take the endpoint away, and it still compiles. The
  // candidate is validated against a page built out of the trace, so nothing it does can reach
  // the live site — which is what makes it safe to validate a script whose real-world
  // equivalent would post, submit or send something.
  const [endpoint] = await db.select().from(cdpEndpoints).where(eq(cdpEndpoints.id, rig.endpointId));
  await db.delete(cdpEndpoints).where(eq(cdpEndpoints.id, rig.endpointId));

  const compiled = await rig.compiles!.runOnce();
  expect(compiled?.result.ok, JSON.stringify(compiled?.result).slice(0, 400)).toBe(true);

  await db.insert(cdpEndpoints).values(endpoint!);

  const promoted = await taskRow();
  expect(promoted.mode).toBe("compiled");
  const scripts = await db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId));
  expect(scripts).toHaveLength(1);
  expect(scripts[0]!.status).toBe("active");
  // Provenance: compiled from exactly the run that just finished (K=1).
  expect(scripts[0]!.fromRuns).toEqual([first.id]);
  // The compile carries its own outcome, on its own row.
  const [job] = await jobsFor(rig, taskId);
  expect(job).toMatchObject({ status: "succeeded", scriptId: scripts[0]!.id, attempts: 1 });
  expect((await eventsOfType(rig as never, "compile.promoted")).length).toBe(1);

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

  // And the dedupe claim is the *same* claim the agent made: three tweets, three events, no
  // matter which mode published them. (A compiled run whose dedupe keys did not match the
  // agent's would republish every tweet on the page, one run after promotion.)
  expect((await eventsOfType(rig as never, "tweet.detected")).length).toBe(3);

  // Still compiled, still one script, and no second compile queued: a clean compiled run
  // neither recompiles nor demotes.
  expect((await taskRow()).mode).toBe("compiled");
  expect(await db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId))).toHaveLength(1);
  expect(await jobsFor(rig, taskId)).toHaveLength(1);
}, 240_000);

/**
 * The property the whole separation exists for: compilation cannot reach back into the run
 * that made it eligible. Here the compiler's model is simply broken — the run still succeeded,
 * the task is untouched, and the failure lands on the job row where it belongs.
 */
it("a compile that fails changes nothing about the run that earned it", async () => {
  rig = await startAgentRig({
    fixtureFor: () => "canonical-fake-tweets.jsonl",
    compileLoop: {
      compilerLlm: () => ({
        complete: async () => {
          throw new Error("the compiler's provider is down");
        },
      }),
    },
  });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, {
    tasks: { Scrape: { mode: "ai", prompt: "Watch the timeline.", emits: ["tweet.detected"] } },
  });
  const taskId = wf.taskIds.Scrape!;

  await triggerTask(db, { taskId });
  await waitForQuiet(rig as never);
  const run = (await runsForTask(rig as never, taskId))[0]!;
  expect(run.status, run.error ?? "").toBe("succeeded");
  expect((await eventsOfType(rig as never, "tweet.detected")).length).toBe(3);

  await rig.compiles!.runOnce();

  // The run stayed succeeded; the task stayed `ai`; the shelf stayed empty.
  const after = (await runsForTask(rig as never, taskId))[0]!;
  expect(after.status).toBe("succeeded");
  expect(after.error).toBeNull();
  expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.mode).toBe("ai");
  expect(await db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId))).toHaveLength(0);

  // The failure is a transport error, not a refusal, so the job goes back on the queue with a
  // backoff and its own budget — none of which the run ever learns about.
  const [job] = await jobsFor(rig, taskId);
  expect(job).toMatchObject({ status: "queued", attempts: 1 });
  expect(job!.error).toContain("provider is down");
  expect(job!.notBefore.getTime()).toBeGreaterThan(Date.now());
}, 240_000);

/** A failed ai run compiles nothing: no job, no script, and the task stays `ai`. */
it("a failed ai run does not even queue a compile", async () => {
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

  expect(await jobsFor(rig, taskId)).toHaveLength(0);
  expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.mode).toBe("ai");
  expect(await db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId))).toHaveLength(0);
  expect(await rig.compiles!.runOnce()).toBeNull();
}, 120_000);

/**
 * The self-healing half, on the same lifecycle: the site changes, the guards fail, the agent
 * finishes the run — and the recovery trace becomes the evidence for the *next* script, after
 * that run settles like any other.
 *
 * The old script's own failed wait is in that trace, and the plan has to throw it away: it is
 * the reason this compile exists, not work to reproduce.
 */
it("a recovered deopt queues a recompile, and the replacement script runs on the new layout", async () => {
  rig = await startAgentRig({
    fixtureFor: () => "deopt-recovery.jsonl",
    compileLoop: { compilerFixture: "compiler-mutator-v2.jsonl" },
  });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, {
    tasks: { Scrape: { mode: "ai", prompt: "Watch the feed and report new items.", emits: ["tweet.detected"] } },
  });
  const taskId = wf.taskIds.Scrape!;

  // A promoted task whose script points at the layout that has since been replaced.
  const stale = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "scripts", "tweets-compiled.js"),
    "utf8",
  )
    .replaceAll("__FX_URL__", rig.fx.url)
    .replace("/fake-tweets", "/mutator?layout=v2");
  const v1 = await insertCandidateScript(db, { taskId, source: stale, fromRuns: ["run_old"] });
  await activateScript(db, v1.id);
  await db.update(tasks).set({ mode: "compiled" }).where(eq(tasks.id, taskId));

  await triggerTask(db, { taskId });
  await waitForQuiet(rig as never);
  const first = (await runsForTask(rig as never, taskId))[0]!;
  expect(first.status, first.error ?? "").toBe("succeeded");
  expect(first.modeUsed).toBe("compiled");

  const [queued] = await jobsFor(rig, taskId);
  expect(queued).toMatchObject({ status: "queued", reason: "recompile", runId: first.id });

  const compiled = await rig.compiles!.runOnce();
  expect(compiled?.result.ok, JSON.stringify(compiled?.result).slice(0, 400)).toBe(true);

  // The task never left `compiled`; the shelf swapped underneath it.
  const scripts = await db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId));
  expect(scripts.map((s) => s.status).sort()).toEqual(["active", "invalidated"]);
  expect(scripts.find((s) => s.status === "active")!.fromRuns).toEqual([first.id]);
  expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.mode).toBe("compiled");

  // And the replacement runs on the new layout without a model call.
  await triggerTask(db, { taskId });
  await waitFor("the second run to exist", async () => (await runsForTask(rig as never, taskId)).length >= 2, 30_000);
  await waitForQuiet(rig as never);
  const second = (await runsForTask(rig as never, taskId))[1]!;
  expect(second.status, second.error ?? "").toBe("succeeded");
  expect((await traceRowsFor(rig, second.id)).filter((r) => r.kind === "llm")).toEqual([]);
}, 240_000);
