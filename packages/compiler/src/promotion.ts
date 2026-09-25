import { compileJobs, compiledScripts, tasks, type Db, type TaskRow } from "@tabductor/db";
import { browserLearningDefinition } from "@tabductor/core";
import type { Metrics } from "@tabductor/telemetry";
import { eq } from "drizzle-orm";
import { activateScript, getActiveScript, invalidateScript } from "./registry.js";

/**
 * When a task becomes *eligible* for the fast path, when it earns it, and when it loses it.
 *
 * The numbers are here rather than spread through the executors: **K=1** — one successful `ai`
 * execution makes its trace eligible to compile (§11's K=2 superseded: the deopt door is what
 * makes an over-fitted script cheap, so paying for a second exploratory run up front buys less
 * than it costs) — and **3 deopts within the last 10** compiled runs demote.
 *
 * Eligibility is not promotion, and this file no longer conflates them. A run finishing makes
 * a *job* (`jobs.ts`); the job compiles, validates in isolation and only then calls
 * `promoteTask`. That separation is the S6e correction: the old `recordAiRun` took a `compile`
 * callback and ran the whole pipeline inside the executor's `finally`, which put an LLM pass
 * and a browser dry run inside the lifetime and timeout of a run that had already finished.
 *
 * Demotion exists so a task that has quietly stopped working stops quietly costing money. A
 * compiled script whose guards fail every run still *finishes* — the agent picks it up — so
 * nothing would ever surface without this. `compile.invalidated` is what makes the user notice.
 */

export const PROMOTE_AFTER_CLEAN_RUNS = 1;
export const DEMOTE_DEOPTS = 3;
export const DEOPT_WINDOW = 10;

/** Never advance for a kind that is not compiled. */
const COMPILABLE_KINDS = new Set(["browser"]);

export type EligibilityOutcome = { eligible: boolean; cleanRuns: number; reason: string };

/**
 * One `ai` run's result, recorded. Returns whether the task's trace is now eligible to
 * compile; the caller enqueues the job.
 */
export async function noteAiRun(
  deps: { db: Db },
  task: TaskRow,
  input: { ok: boolean },
): Promise<EligibilityOutcome> {
  if (!COMPILABLE_KINDS.has(task.kind)) {
    return { eligible: false, cleanRuns: task.cleanAiRuns, reason: `kind ${task.kind} is never compiled` };
  }
  if (!input.ok) {
    await deps.db.update(tasks).set({ cleanAiRuns: 0 }).where(eq(tasks.id, task.id));
    return { eligible: false, cleanRuns: 0, reason: "run failed" };
  }

  const clean = task.cleanAiRuns + 1;
  await deps.db.update(tasks).set({ cleanAiRuns: clean }).where(eq(tasks.id, task.id));
  if (clean < PROMOTE_AFTER_CLEAN_RUNS) {
    return { eligible: false, cleanRuns: clean, reason: `${clean}/${PROMOTE_AFTER_CLEAN_RUNS} clean runs` };
  }
  return { eligible: true, cleanRuns: clean, reason: `${clean} clean run(s)` };
}

/**
 * The fast path, granted. Flipping the mode and activating the script happen together: a task
 * in `compiled` mode with no active script is the one state `CompiledExecutor` cannot do
 * anything useful with.
 *
 * `expectContentHash` is the guard against an obsolete compile overwriting a newer definition
 * (`trace-compilation.md`: "artifacts must match the task content they implement"). The task is
 * re-read *inside* the check because compilation is long and the author may have edited the
 * node while it ran.
 */
export async function promoteTask(
  deps: { db: Db; metrics?: Metrics },
  input: { taskId: string; scriptId: string; expectContentHash: string | null;
    expectScriptId?: string | null; expectDefinitionHash?: string; compileJob?: { id: string; attempts: number } },
): Promise<{ promoted: boolean; reason: string }> {
  return deps.db.transaction(async (trx) => {
    const [task] = await trx.select().from(tasks).where(eq(tasks.id, input.taskId)).for("update");
    if (!task) return { promoted: false, reason: `task ${input.taskId} is gone` };
    if (task.contentHash !== input.expectContentHash) {
      return { promoted: false, reason: "the task changed while its trace was being compiled" };
    }
    if (input.expectDefinitionHash && browserLearningDefinition(task) !== input.expectDefinitionHash) {
      return { promoted: false, reason: "the task definition changed while compiling" };
    }
    if (input.compileJob) {
      const [job] = await trx.select().from(compileJobs).where(eq(compileJobs.id, input.compileJob.id)).for("update");
      if (!job || job.status !== "running" || job.attempts !== input.compileJob.attempts) return { promoted: false, reason: "compile claim lost" };
    }
    if (input.expectScriptId !== undefined && (await getActiveScript(trx, task.id))?.id !== (input.expectScriptId ?? undefined)) {
      return { promoted: false, reason: "active artifact changed while compiling" };
    }
    if (!COMPILABLE_KINDS.has(task.kind)) return { promoted: false, reason: `kind ${task.kind} is never compiled` };
    const [script] = await trx.select().from(compiledScripts).where(eq(compiledScripts.id, input.scriptId)).for("update");
    if (!script || script.taskId !== task.id || script.status === "invalidated") {
      return { promoted: false, reason: "script is absent, retired, or belongs to another task" };
    }
    await activateScript(trx, input.scriptId);
    await trx.update(tasks).set({ mode: "compiled", cleanAiRuns: 0 }).where(eq(tasks.id, task.id));
    deps.metrics?.promotions.add();
    return { promoted: true, reason: "promoted" };
  });
}

export type DemotionOutcome = { demoted: boolean; deoptsInWindow: number };

/**
 * One compiled run's result. Returns whether the task was demoted so the caller can emit
 * `compile.invalidated` on the bus — this module does not publish events, because it has no
 * run to attribute one to.
 */
export async function recordCompiledRun(
  deps: { db: Db; metrics?: Metrics },
  task: TaskRow,
  input: { deopted: boolean; scriptId?: string },
): Promise<DemotionOutcome> {
  return deps.db.transaction(async trx => {
    const [current] = await trx.select().from(tasks).where(eq(tasks.id, task.id)).for("update");
    if (!current) return { demoted: false, deoptsInWindow: 0 };
    const active = await getActiveScript(trx, task.id);
    const prior = Array.isArray(current.recentDeopts) ? current.recentDeopts as boolean[] : [];
    if (input.scriptId && active?.id !== input.scriptId) {
      return { demoted: false, deoptsInWindow: prior.filter(Boolean).length };
    }
    const window = [...prior, input.deopted].slice(-DEOPT_WINDOW);
    const deoptsInWindow = window.filter(Boolean).length;
    if (deoptsInWindow < DEMOTE_DEOPTS) {
      await trx.update(tasks).set({ recentDeopts: window }).where(eq(tasks.id, task.id));
      return { demoted: false, deoptsInWindow };
    }
    if (active) await invalidateScript(trx, active.id);
    await trx.update(tasks).set({ mode: "ai", recentDeopts: [] }).where(eq(tasks.id, task.id));
    deps.metrics?.demotions.add();
    return { demoted: true, deoptsInWindow };
  });
}
