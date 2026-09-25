import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { browserLearningDefinition, createLogger, estimateModelInput, newId, renderLearnedPrompt, SCRIPT_RUNTIME_VERSION, type BrowserProcedure, type Logger } from "@tabductor/core";
import { browserLearningJobs, browserPromptRevisions, browserSessions, browserSessionActivity, compiledScripts, runs, tasks, taskState,
  type BrowserLearningJobRow, type Db, type RunRow, type TaskRow } from "@tabductor/db";
import { enqueueCompileJob, getActiveScript, loadRunTraces, readSdkEvidence } from "@tabductor/compiler";
import { latestBrowserPrompt } from "@tabductor/engine";
import type { Llm } from "./llm.js";
import { maxInputTokensOf } from "./executor-shared.js";
import { BROWSER_LEARNING_INSTRUCTIONS, browserLearningResultSchema, groundLearningResult, learningEvidence, type BrowserLearningResult } from "./learning-evidence.js";

export const LEARNING_STALE_MS = 300_000;
export const LEARNING_TIMEOUT_MS = 120_000;
const terminal = ["succeeded", "failed", "timed_out", "cancelled"] as const;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const owned = (job: BrowserLearningJobRow) => and(eq(browserLearningJobs.id, job.id),
  eq(browserLearningJobs.status, "running"), eq(browserLearningJobs.leaseToken, job.leaseToken!));

export async function enqueueBrowserLearning(db: Db, input: {
  task: TaskRow; run: RunRow; context?: BrowserLearningJobRow["contextJson"];
}) {
  if (input.task.kind !== "browser") return null;
  const [row] = await db.insert(browserLearningJobs).values({ id: newId("blearn"), taskId: input.task.id,
    runId: input.run.id, contentHash: input.task.contentHash, definitionHash: browserLearningDefinition(input.task),
    runtimeVersion: SCRIPT_RUNTIME_VERSION, contextJson: input.context ?? {},
  }).onConflictDoNothing().returning();
  return row ?? null;
}

/** Lock the task as well as the job: separate workers cannot learn competing revisions.
 * Earlier settled runs and retry backoff retain their place in the per-node queue. */
export async function claimBrowserLearning(db: Db, now = new Date()) {
  return db.transaction(async trx => {
    const [pick] = await trx.select({ job: browserLearningJobs }).from(browserLearningJobs)
      .innerJoin(tasks, eq(tasks.id, browserLearningJobs.taskId))
      .innerJoin(runs, eq(runs.id, browserLearningJobs.runId))
      .where(and(inArray(runs.status, [...terminal]), lte(browserLearningJobs.notBefore, now),
        or(eq(browserLearningJobs.status, "queued"), and(eq(browserLearningJobs.status, "running"), lte(browserLearningJobs.heartbeatAt, new Date(now.getTime() - LEARNING_STALE_MS)))),
        sql`not exists (
          select 1 from browser_learning_jobs other join runs other_run on other_run.id = other.run_id
          where other.task_id = ${browserLearningJobs.taskId} and other.id <> ${browserLearningJobs.id}
          and other.status in ('queued','running') and (
            other.status = 'running' or (${browserLearningJobs.status} <> 'running'
              and other_run.status in ('succeeded','failed','timed_out','cancelled')
              and (coalesce(other_run.ended_at, other.created_at), other.id) < (coalesce(${runs.endedAt}, ${browserLearningJobs.createdAt}), ${browserLearningJobs.id}))
          ))`,
      )).orderBy(asc(runs.endedAt), asc(browserLearningJobs.createdAt), asc(browserLearningJobs.id)).limit(1)
      .for("update", { of: [tasks, browserLearningJobs], skipLocked: true });
    if (!pick) return null;
    const [job] = await trx.update(browserLearningJobs).set({ status: "running", attempts: pick.job.attempts + 1,
      leaseToken: newId("learnlease"), heartbeatAt: now }).where(eq(browserLearningJobs.id, pick.job.id)).returning();
    return job!;
  });
}

/** A pending recommendation survives a busy compilation queue. */
export async function dispatchLearningCompile(db: Db) {
  const [pending] = await db.select().from(browserLearningJobs).where(and(eq(browserLearningJobs.status, "succeeded"),
    eq(browserLearningJobs.compileRequested, true), isNull(browserLearningJobs.compileJobId),
    sql`not exists (select 1 from compile_jobs where task_id = ${browserLearningJobs.taskId} and status in ('queued','running'))`,
  )).orderBy(asc(browserLearningJobs.createdAt)).limit(1);
  if (!pending) return;
  await db.transaction(async trx => {
    const [task] = await trx.select().from(tasks).where(eq(tasks.id, pending.taskId)).for("update");
    const [job] = await trx.select().from(browserLearningJobs).where(eq(browserLearningJobs.id, pending.id)).for("update");
    if (!job?.compileRequested || job.compileJobId || !task) return;
    const active = await getActiveScript(trx, task.id);
    // Demotion can retire the source artifact; a replacement artifact must not be overwritten.
    if (browserLearningDefinition(task) !== job.definitionHash || active && active.id !== job.contextJson.scriptId) {
      await trx.update(browserLearningJobs).set({ compileRequested: false, error: "Compilation superseded by a changed task or artifact" }).where(eq(browserLearningJobs.id, job.id));
      return;
    }
    const compile = await enqueueCompileJob(trx, { taskId: task.id, runId: job.runId,
      reason: active ? "recompile" : "promote", contentHash: task.contentHash, learningJobId: job.id, expectedScriptId: active?.id ?? null });
    if (compile) await trx.update(browserLearningJobs).set({ compileJobId: compile.id }).where(eq(browserLearningJobs.id, job.id));
  });
}

export type BrowserLearningWorkerDeps = {
  db: Db; blobs?: { get(ref: string): Promise<Buffer> };
  llmFor: (input: { task: TaskRow; job: BrowserLearningJobRow }) => Llm;
  logger?: Logger; pollMs?: number; timeoutMs?: number;
};

export function createBrowserLearningWorker(deps: BrowserLearningWorkerDeps) {
  const { db } = deps, log = deps.logger ?? createLogger({ name: "browser-learning" });
  const refuse = async (job: BrowserLearningJobRow, error: string) => {
    await db.update(browserLearningJobs).set({ status: "refused", error, endedAt: new Date(), heartbeatAt: null }).where(owned(job));
  };
  async function runOnce(): Promise<BrowserLearningJobRow | null> {
    await dispatchLearningCompile(db);
    const job = await claimBrowserLearning(db);
    if (!job) return null;
    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      void db.update(browserLearningJobs).set({ heartbeatAt: new Date() }).where(owned(job)).returning({ id: browserLearningJobs.id })
        .then(rows => { if (!rows.length) abort.abort(new Error("Learning claim lost")); }).catch(() => abort.abort());
    }, 30_000);
    heartbeat.unref?.();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, job.taskId));
      if (!task || browserLearningDefinition(task) !== job.definitionHash || job.runtimeVersion !== SCRIPT_RUNTIME_VERSION) {
        await refuse(job, "Task definition or runtime changed"); return job;
      }
      const [run] = await db.select().from(runs).where(eq(runs.id, job.runId));
      const [trace] = await loadRunTraces(db, [job.runId], deps.blobs);
      if (!run || !trace) { await refuse(job, "Run evidence unavailable"); return job; }
      const evidence = learningEvidence(trace);
      if (!evidence.entries.length) { await refuse(job, "No retained browser evidence"); return job; }
      const baseline = task.baselineCompiledPrompt ?? task.compiledPrompt ?? task.prompt ?? "";
      const previous = task.learningRuntimeVersion === SCRIPT_RUNTIME_VERSION
        ? await latestBrowserPrompt(db, task.id, task.contentHash, "ai") : undefined;
      const procedure = previous?.dataJson.procedure as BrowserProcedure | undefined;
      const scope = job.contextJson.scriptKey && job.contextJson.deoptKey ? `${job.contextJson.scriptKey}:${job.contextJson.deoptKey}` : undefined;
      const priorDeopt = scope ? await latestBrowserPrompt(db, task.id, task.contentHash, "deopt", scope) : undefined;
      const [artifact] = job.contextJson.scriptId ? await db.select().from(compiledScripts).where(eq(compiledScripts.id, job.contextJson.scriptId)) : [];
      const [assisted] = run.executionId ? await db.select({ id: browserSessions.id }).from(browserSessions)
        .innerJoin(browserSessionActivity, eq(browserSessionActivity.sessionId, browserSessions.id))
        .where(and(eq(browserSessions.executionId, run.executionId), eq(browserSessionActivity.kind, "takeover_started"))).limit(1) : [];
      const [progress] = await db.select().from(taskState).where(and(eq(taskState.taskId, task.id), eq(taskState.key, `agent-code-progress:${run.id}`)));
      let compileBlock: string | undefined;
      if (run.status !== "succeeded") compileBlock = "Source run did not succeed";
      else if (assisted) compileBlock = "Human-assisted execution cannot compile";
      else if (object(progress?.value).requiresReconciliation || object(progress?.value).inFlight) compileBlock = "Unresolved browser effects";
      else try { readSdkEvidence(trace); } catch (error) { compileBlock = String(error); }
      const requestData = { baseline, previous: procedure ?? null, outcome: { status: run.status, error: run.error, assisted: !!assisted },
        deopt: scope ? { scope, planned: job.contextJson.planned === true, previousPrompt: priorDeopt?.prompt, previousEvidence: priorDeopt?.dataJson.evidence,
          artifactPlan: object(artifact?.guardsMeta).plan } : null,
        statistics: { totalEntries: evidence.entries.length, failedOperations: evidence.failedOperations, uncertainEffects: evidence.uncertainEffects },
        compileBlock, evidence: evidence.entries };
      const tokenLimit = maxInputTokensOf(task) ?? 32000;
      // Keep the complete event index and counts, shrinking large payload previews first.
      for (const limit of [1000, 250, 0]) {
        if (estimateModelInput(requestData).inputTokenBound <= tokenLimit - 4000) break;
        requestData.evidence = requestData.evidence.map(entry => ({ ...entry,
          evidence: entry.evidence.slice(0, limit), truncated: entry.truncated || entry.evidence.length > limit }));
      }
      if (estimateModelInput(requestData).inputTokenBound > tokenLimit - 4000) {
        await refuse(job, "Learning evidence exceeds the model context budget"); return job;
      }
      const response = await Promise.race([
        deps.llmFor({ task, job }).complete({ system: BROWSER_LEARNING_INSTRUCTIONS,
          messages: [{ role: "user", content: JSON.stringify(requestData) }], tools: [], signal: abort.signal }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => { abort.abort(); reject(new Error("Browser learning timed out")); }, deps.timeoutMs ?? LEARNING_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
      abort.signal.throwIfAborted();
      const parsed = browserLearningResultSchema.parse(JSON.parse((response.text ?? "").trim().replace(/^```(?:json)?\s*\n/, "").replace(/\n```$/, "")));
      const result = groundLearningResult(parsed, { evidence, previous: procedure,
        previousDeoptEvidence: priorDeopt?.dataJson.evidence as string[] | undefined, succeeded: run.status === "succeeded", hasDeopt: !!scope });
      if (compileBlock) result.compile = { eligible: false, reason: compileBlock, evidence: [] };
      if (result.procedure && estimateModelInput(renderLearnedPrompt(baseline, result.procedure)).inputTokenBound > tokenLimit / 2) {
        throw new Error("Improved prompt leaves insufficient context for browser tools and observations");
      }
      const applied = await applyResult(job, task, baseline, result, scope);
      log.info(applied ? "browser learning completed" : "browser learning superseded", { jobId: job.id, runId: job.runId,
        compileEligible: applied && result.compile.eligible });
      await dispatchLearningCompile(db);
      return job;
    } catch (error) {
      const retry = job.attempts < 3;
      await db.update(browserLearningJobs).set({ status: retry ? "queued" : "failed", error: String(error).slice(0, 4000),
        heartbeatAt: null, leaseToken: null, notBefore: new Date(Date.now() + 30_000), endedAt: retry ? null : new Date(),
      }).where(owned(job));
      log.warn("browser learning failed", { jobId: job.id, error: String(error) });
      return job;
    } finally { clearInterval(heartbeat); if (timeout) clearTimeout(timeout); }
  }

  async function applyResult(job: BrowserLearningJobRow, snapshot: TaskRow, baseline: string, result: BrowserLearningResult, scope?: string) {
    return db.transaction(async trx => {
      const [task] = await trx.select().from(tasks).where(eq(tasks.id, job.taskId)).for("update");
      const [claim] = await trx.select().from(browserLearningJobs).where(owned(job)).for("update");
      if (!claim) return false;
      if (!task || browserLearningDefinition(task) !== job.definitionHash || task.learningRevision !== snapshot.learningRevision) {
        await trx.update(browserLearningJobs).set({ status: "refused", error: "Task or prompt revision changed during learning", endedAt: new Date() }).where(owned(job));
        return false;
      }
      const revision = task.learningRevision + 1;
      let changed = false;
      if (result.procedure) {
        const prior = await latestBrowserPrompt(trx, task.id, task.contentHash, "ai");
        const prompt = renderLearnedPrompt(baseline, result.procedure);
        if (prompt !== task.compiledPrompt) {
          await trx.insert(browserPromptRevisions).values({ id: newId("bprompt"), taskId: task.id, revision, lane: "ai",
            contentHash: task.contentHash, runtimeVersion: SCRIPT_RUNTIME_VERSION, sourceRunId: job.runId,
            previousRevisionId: prior?.id, baselinePrompt: baseline, prompt, dataJson: { procedure: result.procedure } });
          await trx.update(tasks).set({ baselineCompiledPrompt: baseline, compiledPrompt: prompt }).where(eq(tasks.id, task.id));
          changed = true;
        }
      }
      const active = await getActiveScript(trx, task.id);
      if (result.deopt && scope && active && active.id === job.contextJson.scriptId) {
        const prior = await latestBrowserPrompt(trx, task.id, task.contentHash, "deopt", scope);
        if (prior?.prompt !== result.deopt.prompt) {
          await trx.insert(browserPromptRevisions).values({ id: newId("bprompt"), taskId: task.id, revision, lane: "deopt", scopeKey: scope,
            contentHash: task.contentHash, runtimeVersion: SCRIPT_RUNTIME_VERSION, sourceRunId: job.runId,
            previousRevisionId: prior?.id, baselinePrompt: JSON.stringify(object(active.guardsMeta).plan ?? {}),
            prompt: result.deopt.prompt, dataJson: { evidence: result.deopt.evidence } });
          changed = true;
        }
      }
      if (changed) await trx.update(tasks).set({ learningRevision: revision, learningRuntimeVersion: SCRIPT_RUNTIME_VERSION }).where(eq(tasks.id, task.id));
      if (!job.contextJson.scriptId) await trx.update(tasks).set({ cleanAiRuns: result.compile.eligible ? task.cleanAiRuns + 1 : 0 }).where(eq(tasks.id, task.id));
      await trx.update(browserLearningJobs).set({ status: "succeeded", resultJson: result,
        compileRequested: result.compile.eligible, endedAt: new Date(), heartbeatAt: null, error: null }).where(owned(job));
      return true;
    });
  }

  let timer: ReturnType<typeof setInterval> | undefined, inFlight: Promise<unknown> | undefined;
  return { runOnce,
    start() {
      if (timer) return;
      const tick = () => { if (!inFlight) inFlight = runOnce().catch(error => log.warn("learning worker tick failed", { error: String(error) })).finally(() => { inFlight = undefined; }); };
      timer = setInterval(tick, deps.pollMs ?? 1000); timer.unref?.(); tick();
    },
    async stop() { if (timer) clearInterval(timer); timer = undefined; await inFlight; },
  };
}
