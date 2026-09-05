import { tasks, type Db, type TaskRow } from "@tabductor/db";
import type { Metrics } from "@tabductor/telemetry";
import { eq } from "drizzle-orm";
import { activateScript, getActiveScript, invalidateScript } from "./registry.js";

/**
 * When a task earns the fast path, and when it loses it.
 *
 * The numbers are here rather than spread through the executors: **K=1** — the first clean
 * `ai` run compiles (a product decision superseding §11's K=2: the deopt door is what makes
 * an over-fitted script cheap, so paying for a second exploratory run up front buys less
 * than it costs; consistency against the previous run is still checked whenever there *is*
 * one) — and **3 deopts within the last 10** compiled runs demote. Both are policy, and policy belongs in one readable place; the executors only report
 * what happened.
 *
 * Demotion exists so a task that has quietly stopped working stops quietly costing money. A
 * compiled script whose guards fail every run still *finishes* — the agent picks it up — so
 * nothing would ever surface without this. `compile.invalidated` is what makes the user notice.
 */

export const PROMOTE_AFTER_CLEAN_RUNS = 1;
export const DEMOTE_DEOPTS = 3;
export const DEOPT_WINDOW = 10;

/** Never advance for a kind that is not compiled — an asset task must not accumulate toward a
 * promotion that S6b's selector would refuse anyway. */
const COMPILABLE_KINDS = new Set(["browser"]);

export type PromotionDeps = {
  db: Db;
  metrics?: Metrics;
  /** Runs S6b's pipeline. Injected so this module stays policy and does not import the model. */
  compile: (taskId: string) => Promise<{ ok: true; scriptId: string } | { ok: false; error: string }>;
};

export type PromotionOutcome =
  | { promoted: false; reason: string }
  | { promoted: true; scriptId: string };

/**
 * One `ai` run's result. `consistent` is S6b's consistency verdict against the previous run —
 * two successes that did different things are not two clean runs, they are one task with two
 * behaviours, and compiling either would be compiling a coincidence.
 */
export async function recordAiRun(
  deps: PromotionDeps,
  task: TaskRow,
  input: { ok: boolean; consistent: boolean },
): Promise<PromotionOutcome> {
  if (!COMPILABLE_KINDS.has(task.kind)) return { promoted: false, reason: `kind ${task.kind} is never compiled` };

  if (!input.ok || !input.consistent) {
    await deps.db.update(tasks).set({ cleanAiRuns: 0 }).where(eq(tasks.id, task.id));
    return { promoted: false, reason: input.ok ? "runs diverged" : "run failed" };
  }

  const clean = task.cleanAiRuns + 1;
  await deps.db.update(tasks).set({ cleanAiRuns: clean }).where(eq(tasks.id, task.id));
  if (clean < PROMOTE_AFTER_CLEAN_RUNS) {
    return { promoted: false, reason: `${clean}/${PROMOTE_AFTER_CLEAN_RUNS} clean runs` };
  }

  const compiled = await deps.compile(task.id);
  if (!compiled.ok) return { promoted: false, reason: compiled.error };

  // Flip the mode and activate in one place: a task in `compiled` mode with no active script
  // is the one state `CompiledExecutor` cannot do anything useful with.
  await activateScript(deps.db, compiled.scriptId);
  await deps.db.update(tasks).set({ mode: "compiled", cleanAiRuns: 0 }).where(eq(tasks.id, task.id));
  deps.metrics?.promotions.add();
  return { promoted: true, scriptId: compiled.scriptId };
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
  input: { deopted: boolean },
): Promise<DemotionOutcome> {
  const prior = Array.isArray(task.recentDeopts) ? (task.recentDeopts as boolean[]) : [];
  const window = [...prior, input.deopted].slice(-DEOPT_WINDOW);
  const deoptsInWindow = window.filter(Boolean).length;

  if (deoptsInWindow < DEMOTE_DEOPTS) {
    await deps.db.update(tasks).set({ recentDeopts: window }).where(eq(tasks.id, task.id));
    return { demoted: false, deoptsInWindow };
  }

  const active = await getActiveScript(deps.db, task.id);
  if (active) await invalidateScript(deps.db, active.id);
  // The window is cleared with the demotion: the next compiled run, if this task is ever
  // promoted again, starts its own ten.
  await deps.db.update(tasks).set({ mode: "ai", recentDeopts: [] }).where(eq(tasks.id, task.id));
  deps.metrics?.demotions.add();
  return { demoted: true, deoptsInWindow };
}
