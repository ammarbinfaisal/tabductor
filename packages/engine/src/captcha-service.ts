import { assertCaptchaIncluded } from "./subscriptions.js";
import { recordCost } from "./billing-prices.js";
import { findBillingRate } from "./billing-prices.js";
import { createHash } from "node:crypto";
import { AppError, canonicalJson, newId, usdDecimal } from "@tabductor/core";
import { billingRates, browserSessions, captchaJobs, workflowVersions, workflows, type Db } from "@tabductor/db";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import type { RunHandle } from "./executor.js";
import { assertRunLease } from "./run-lease.js";
import { browserAutomationIsReady } from "./browser-session-control.js";
import { settleCreditReservation } from "./credits.js";
import { captchaCreateSchema, type CaptchaCreate, type CaptchaProvider, type CaptchaProviderResult } from "./captcha-providers.js";

type Job = typeof captchaJobs.$inferSelect;
export type CaptchaJob = {
  id: string; provider: string; task_type: string; status: Job["status"];
  solution?: Record<string, unknown>; error_code?: string; retry_after_ms?: number;
};
export type CaptchaService = ReturnType<typeof createCaptchaService>;
const failure = (code: string, message: string) => new AppError(code, message, { details: { outcomeUncertain: false } });
const describe = (job: Job): CaptchaJob => ({ id: job.id, provider: job.provider, task_type: job.taskType, status: job.status,
  ...(job.solutionJson ? { solution: job.solutionJson } : {}), ...(job.errorCode ? { error_code: job.errorCode } : {}),
  ...(["pending", "submitting"].includes(job.status) ? { retry_after_ms: Math.max(1000, job.nextPollAt.getTime() - Date.now()) } : {}) });

/** One job is scoped to one run, including resumed leases. The durable submission intent
 * prevents a process crash or Python timeout from purchasing the same solve twice. */
export function createCaptchaService(input: { db: Db; handle: RunHandle; providers: readonly CaptchaProvider[] }) {
  const { db, handle, providers } = input;
  const guard = async (trx: Db, signal?: AbortSignal) => {
    handle.signal.throwIfAborted(); signal?.throwIfAborted();
    await assertRunLease(trx, handle.run.id, handle.run.leaseGeneration);
    if (handle.run.executionId) {
      const [session] = await trx.select().from(browserSessions).where(and(eq(browserSessions.executionId, handle.run.executionId), inArray(browserSessions.status, ["ready", "running"])));
      if (!session || !browserAutomationIsReady(session)) throw failure("browser_input_revoked", "CAPTCHA operations require active browser automation control");
    }
  };
  const providerFor = (name: string) => {
    const provider = providers.find(p => p.name === name);
    if (!provider?.configured) throw failure("captcha_not_configured", `${name}: provider API key is not configured`);
    return provider;
  };
  const scopedJob = async (trx: Db, id: string) => {
    const [job] = await trx.select().from(captchaJobs).where(and(eq(captchaJobs.id, id), eq(captchaJobs.runId, handle.run.id))).for("update");
    if (!job) throw failure("captcha_job_not_found", "No CAPTCHA job with this id belongs to this run");
    return job;
  };
  const persist = async (job: Job, result: CaptchaProviderResult) => db.transaction(async trx => {
    const current = await scopedJob(trx, job.id);
    if (["ready", "failed"].includes(current.status)) return describe(current);
    if (result.status !== "pending" && job.reservationId) await settleCreditReservation(trx, { accountId: job.accountId, reservationId: job.reservationId,
      actualUnits: result.status === "ready" ? job.creditUnits : 0 });
    if (result.status !== "pending" && !job.reservationId) await settleIncludedCaptcha(trx, job.id, result.status === "ready");
    const [updated] = await trx.update(captchaJobs).set({ status: result.status,
      providerTaskId: result.taskId ?? job.providerTaskId, solutionJson: result.solution ?? null, errorCode: result.errorCode ?? null,
      nextPollAt: new Date(Date.now() + 5000) }).where(eq(captchaJobs.id, job.id)).returning();
    return describe(updated!);
  });
  const uncertain = async (job: Job) => {
    // Known provider IDs remain pollable after timeouts. Unknown submissions stay held
    // for reconciliation, rather than releasing funds for a potentially accepted solve.
    const [updated] = await db.update(captchaJobs).set({ status: job.providerTaskId ? "pending" : "uncertain",
      errorCode: job.providerTaskId ? "POLL_UNACKNOWLEDGED" : "SUBMISSION_UNACKNOWLEDGED", nextPollAt: new Date(Date.now() + 5000) })
      .where(and(eq(captchaJobs.id, job.id), inArray(captchaJobs.status, ["submitting", "pending", "uncertain"]))).returning();
    return updated ? describe(updated) : db.transaction(async trx => describe(await scopedJob(trx, job.id)));
  };
  return {
    async providers() {
      return Promise.all(providers.map(async p => { const rates=await db.select().from(billingRates).where(and(eq(billingRates.category,"solver"),eq(billingRates.provider,p.name))).orderBy(desc(billingRates.createdAt),desc(billingRates.id)); const rate=rates.find(r=>r.item==="*"); return ({ name: p.name, available: p.configured && Boolean(p.rate||rates.length),
        reason: !p.configured ? "missing_api_key" : !p.rate&&!rates.length ? "missing_internal_rate" : null,
        pricing: "USD rate depends on the native task type; a configured rate is required before submission",
        ...(rate ? { price_usd: usdDecimal(rate.chargeMicros), rate_version: rate.id } : {}),
        documentation: p.documentation, task_format: "Native provider task object; all provider-supported task types and fields are accepted",
        ...(p.name === "anti-captcha" ? { additional_operations: ["push_variable"] } : {}) }); }));
    },
    async createTask(raw: CaptchaCreate, signal?: AbortSignal): Promise<CaptchaJob> {
      const args = captchaCreateSchema.parse(raw);
      if (Buffer.byteLength(JSON.stringify(args)) > 2_000_000) throw failure("captcha_task_too_large", "CAPTCHA task exceeds 2 MB");
      const digest = createHash("sha256").update(canonicalJson({provider:args.provider,task:args.task,options:args.options})).digest("hex");
      const claimed = await db.transaction(async trx => {
        await guard(trx, signal);
        const [existing] = await trx.select().from(captchaJobs).where(and(eq(captchaJobs.runId, handle.run.id), eq(captchaJobs.idempotencyKey, args.idempotency_key))).for("update");
        if (existing) {
          if (existing.requestDigest !== digest) throw failure("captcha_idempotency_conflict", "This idempotency key already identifies a different CAPTCHA task");
          return { job: existing, submit: false };
        }
        const [inFlight] = await trx.select().from(captchaJobs).where(and(eq(captchaJobs.runId, handle.run.id), eq(captchaJobs.requestDigest, digest), inArray(captchaJobs.status, ["submitting", "pending", "uncertain"])));
        if (inFlight) return { job: inFlight, submit: false };
        const provider = providerFor(args.provider);
        const configured=await findBillingRate(trx,"solver",args.provider,args.task.type);
        const rate=configured?{creditUnits:configured.chargeMicros,rateVersion:configured.id}:provider.rate;
        if (!rate || rate.creditUnits<=0) throw failure("captcha_rate_missing", `${args.provider}: set a USD price for ${args.task.type} in Admin before submitting paid solves`);
        const [scope] = await trx.select({ accountId: workflows.accountId }).from(workflowVersions)
          .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId)).where(eq(workflowVersions.id, handle.task.workflowVersionId));
        if (!scope) throw failure("captcha_scope_missing", "Workflow account is unavailable");
        const id = newId("captcha");
        const plan = await assertCaptchaIncluded(trx, scope.accountId);
        await recordCost(trx, { accountId: scope.accountId, category: "solver", provider: args.provider, sourceId: id, costMicros: null });
        await trx.execute(sql`update operating_costs set status='pending',plan_revision_id=${plan.id},snapshot=${JSON.stringify({ unitCharge: 0, unitCost: configured?.costMicros ?? null })}::jsonb where source_id=${id} and category='solver'`);
        const [job] = await trx.insert(captchaJobs).values({ id, runId: handle.run.id, accountId: scope.accountId, idempotencyKey: args.idempotency_key,
          requestDigest: digest, provider: args.provider, taskType: args.task.type, status: "submitting", rateVersion: rate.rateVersion,
          creditUnits: 0, reservationId: null, nextPollAt: new Date(Date.now() + 20000) }).returning();
        return { job: job!, submit: true };
      });
      if (!claimed.submit) return describe(claimed.job);
      const combined = signal ? AbortSignal.any([handle.signal, signal]) : handle.signal;
      try {
        await db.transaction(trx => guard(trx, combined));
      } catch (error) {
        await persist(claimed.job, { status: "failed", errorCode: "CANCELLED_BEFORE_SUBMISSION" });
        throw error;
      }
      try { return await persist(claimed.job, await providerFor(args.provider).submit(args, combined)); }
      catch { return uncertain(claimed.job); }
    },
    async getResult(id: string, signal?: AbortSignal): Promise<CaptchaJob> {
      const claimed = await db.transaction(async trx => {
        await guard(trx, signal);
        const job = await scopedJob(trx, id);
        if (job.status === "submitting" && job.nextPollAt.getTime() <= Date.now()) {
          const [updated] = await trx.update(captchaJobs).set({status:"uncertain",errorCode:"SUBMISSION_UNACKNOWLEDGED"}).where(eq(captchaJobs.id,id)).returning();
          return {job:updated!,poll:false};
        }
        if (job.status !== "pending" || !job.providerTaskId || job.nextPollAt.getTime() > Date.now()) return { job, poll: false };
        providerFor(job.provider);
        await trx.update(captchaJobs).set({ nextPollAt: new Date(Date.now() + 20000) }).where(eq(captchaJobs.id, id));
        return { job, poll: true };
      });
      if (!claimed.poll) return describe(claimed.job);
      try { return await persist(claimed.job, await providerFor(claimed.job.provider).poll(claimed.job.providerTaskId!, signal ? AbortSignal.any([signal,handle.signal]) : handle.signal)); }
      catch { return uncertain(claimed.job); }
    },
    async pushVariable(id: string, name: string, value: unknown, signal?: AbortSignal): Promise<void> {
      if (!name || name.length > 200 || Buffer.byteLength(JSON.stringify(value) ?? "") > 100000) throw failure("captcha_variable_invalid", "Provide a bounded variable name and JSON value");
      const job = await db.transaction(async trx => { await guard(trx, signal); return scopedJob(trx, id); });
      if (job.provider !== "anti-captcha" || job.taskType !== "AntiGateTask" || job.status !== "pending" || !job.providerTaskId)
        throw failure("captcha_operation_unsupported", "push_variable requires a pending Anti-Captcha AntiGateTask");
      await providerFor(job.provider).pushVariable(job.providerTaskId, name, value, signal ? AbortSignal.any([signal,handle.signal]) : handle.signal);
    },
  };
}

/** Poll already-purchased tasks independently of run leases, including cancelled runs.
 * Never resubmit an uncertain task: an operator must reconcile an unknown provider ID. */
export async function reconcileCaptchaJobs(db:Db,providers:readonly CaptchaProvider[]){
  const job=await db.transaction(async trx=>{
    await trx.execute(sql`update captcha_jobs set status='uncertain',error_code='SUBMISSION_UNACKNOWLEDGED' where status='submitting' and next_poll_at < now()-interval '1 minute'`);
    const [row]=await trx.select().from(captchaJobs).where(and(eq(captchaJobs.status,"pending"),sql`${captchaJobs.nextPollAt} <= now()`)).orderBy(captchaJobs.nextPollAt).limit(1).for("update",{skipLocked:true});
    if(!row)return null;
    await trx.update(captchaJobs).set({nextPollAt:new Date(Date.now()+30000)}).where(eq(captchaJobs.id,row.id));return row;
  });
  if(!job?.providerTaskId)return;
  const provider=providers.find(p=>p.name===job.provider&&p.configured);if(!provider)return;
  let result:CaptchaProviderResult;
  try{result=await provider.poll(job.providerTaskId,AbortSignal.timeout(15000));}catch{return;}
  await db.transaction(async trx=>{
    const [current]=await trx.select().from(captchaJobs).where(eq(captchaJobs.id,job.id)).for("update");
    if(!current||current.status!=="pending")return;
    if(result.status!=="pending" && job.reservationId)await settleCreditReservation(trx,{accountId:job.accountId,reservationId:job.reservationId,actualUnits:result.status==="ready"?job.creditUnits:0});
    if (result.status !== "pending" && !job.reservationId) await settleIncludedCaptcha(trx, job.id, result.status === "ready");
    await trx.update(captchaJobs).set({status:result.status,solutionJson:result.solution??null,errorCode:result.errorCode??null,nextPollAt:new Date(Date.now()+5000)}).where(eq(captchaJobs.id,job.id));
  });
}

export async function settleIncludedCaptcha(db: Db, id: string, solved: boolean) {
  await db.execute(sql`update operating_costs set status='settled',cost_micros=case when ${solved} then (snapshot->>'unitCost')::bigint else 0 end where source_id=${id} and category='solver'`);
}
