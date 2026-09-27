import { currentBrowserOperation } from "@tabductor/browser/operation-context";
import { findBillingRate } from "./billing-prices.js";
import { requestChallengeRecovery, advanceChallengeRecovery, type SolverProvider } from "./challenge-recovery.js";
import { createHmac } from "node:crypto";
import { AppError, newId } from "@tabductor/core";
import type { EndpointPool } from "@tabductor/browser";
import { createCamoufoxWorkerDriver } from "@tabductor/browser/worker-driver";
import { browserSessionActivity, browserSessions, browserCommands, workflowBrowserProfiles, workflows, runs, workflowVersions, tasks, browserBilling, type Db } from "@tabductor/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createBrowserProfile, ensureExecutionBrowserSession, type BrowserAdmission } from "./browser-fleet.js";
import { requestBrowserTakeover, browserAutomationIsReady } from "./browser-session-control.js";
import { assertBrowserTabLease, browserTabKey, claimBrowserTab, releaseBrowserTab, type BrowserTabLease } from "./browser-tabs.js";
import { assertRunLease } from "./run-lease.js";
import { reserveCredits, settleCreditReservation } from "./credits.js";

export function browserWorkerToken(key: string, podName: string): string {
  if (key.length < 32) throw new AppError("worker_key_invalid", "worker signing key must contain at least 32 characters");
  return createHmac("sha256", key).update(`worker:${podName}`).digest("base64url");
}

/** Creates a stable profile once, so replacing a browser retains its authenticated state. */
export async function ensureWorkflowBrowserProfile(db: Db, accountId: string, workflowId: string): Promise<string> {
  return db.transaction(async (trx) => {
    const [workflow] = await trx.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.accountId, accountId))).for("update");
    if (!workflow) throw new AppError("workflow_not_found", "workflow not found");
    const [binding] = await trx.select().from(workflowBrowserProfiles).where(eq(workflowBrowserProfiles.workflowId, workflowId));
    if (binding) return binding.profileId;
    const profileId = await createBrowserProfile(trx, { accountId, name: `Workflow ${workflowId}` });
    await trx.insert(workflowBrowserProfiles).values({ workflowId, profileId });
    return profileId;
  });
}

export function browserCreditAdmission(rate: { version: string; unitsPerMinute: number; maxSeconds: number }): BrowserAdmission {
  if (!rate.version || !Number.isSafeInteger(rate.unitsPerMinute) || rate.unitsPerMinute < 0 || !Number.isSafeInteger(rate.maxSeconds) || rate.maxSeconds < 60 || rate.maxSeconds > 86400) {
    throw new AppError("browser_rate_invalid", "browser allocation requires a versioned rate and a bounded session duration");
  }
  return { async reserve(input, trx) {
    const configured=await findBillingRate(trx,"browser","","minute");
    const unitsPerMinute=configured?.chargeMicros??rate.unitsPerMinute;
    if(unitsPerMinute<=0)throw new AppError("browser_rate_missing","Set a browser USD/minute rate in Admin before allocating a paid browser.");
    const reservation = await reserveCredits(trx, { accountId: input.accountId, operationId: `browser:${input.sessionId}`, category: "browser", units: Math.ceil(rate.maxSeconds / 60) * unitsPerMinute, ttlMs: 86400_000,
      cost:{provider:"browser",rateId:configured?.id??rate.version,unitCharge:unitsPerMinute,unitCost:configured?.costMicros??null} });
    await trx.insert(browserBilling).values({ sessionId: input.sessionId, reservationId: reservation.id, rateVersion: configured?.id??rate.version, unitsPerMinute, maxSeconds: rate.maxSeconds });
  } };
}

export async function settleBrowserUsage(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const [session] = await trx.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
    const [billing] = await trx.select().from(browserBilling).where(eq(browserBilling.sessionId, sessionId)).for("update");
    if (!billing || billing.endedAt || !session?.endedAt) return;
    const seconds = session.readyAt ? Math.min(billing.maxSeconds, Math.max(0, (session.endedAt.getTime() - session.readyAt.getTime()) / 1000)) : 0;
    await settleCreditReservation(trx, { accountId: session.accountId, reservationId: billing.reservationId,
      actualUnits: Math.ceil(seconds / 60) * billing.unitsPerMinute });
    await trx.update(browserBilling).set({ endedAt: session.endedAt }).where(eq(browserBilling.sessionId, sessionId));
  });
}

/** The engine's hosted pool has the same executor interface as the development CDP pool. */
export function createHostedBrowserPool(deps: { db: Db; tokenKey: string; workerUrl: (podName: string) => Promise<string>;
  challengeRecovery?: "automatic" | "agent";
  solvers?: readonly SolverProvider[]; fetch?: typeof fetch; allocationTimeoutMs?: number }): EndpointPool {
  let closed = false;
  const active = new Map<string, () => Promise<void>>();
  const request = deps.fetch ?? fetch;
  return {
    async acquire(_endpointId, runId) {
      if (closed) throw new AppError("browser.disconnected", "browser pool closed");
      const [row] = await deps.db.select({ run: runs, accountId: workflows.accountId, workflowId: workflows.id, task: tasks }).from(runs)
        .innerJoin(tasks, eq(tasks.id, runs.taskId)).innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
        .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId)).where(eq(runs.id, runId));
      if (!row || !row.run.executionId || row.run.status !== "running") throw new AppError("run_lease_lost", "active execution is required for a hosted browser");
      const profileId = await ensureWorkflowBrowserProfile(deps.db, row.accountId, row.workflowId);
      const sessionId = await ensureExecutionBrowserSession(deps.db, { accountId: row.accountId, profileId, executionId: row.run.executionId });
      const tabLease: BrowserTabLease = { sessionId, tabKey: browserTabKey(row.task), runId,
        runGeneration: row.run.leaseGeneration, taskId: row.task.id };
      const leaseId = newId("tab_lease");
      let released = false;
      let closeConnection: (() => Promise<void>) | undefined;
      const release = async () => {
        if (released) return;
        released = true;
        try { await closeConnection?.(); } finally {
          await releaseBrowserTab(deps.db, tabLease);
          active.delete(leaseId);
        }
      };
      active.set(leaseId, release);
      const started = Date.now();
      try {
        while (!closed && Date.now() - started < (deps.allocationTimeoutMs ?? 120_000)) {
          await deps.db.transaction((trx) => assertRunLease(trx, runId, row.run.leaseGeneration));
          const [session] = await deps.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
          if (!session || ["ended", "failed", "stopping"].includes(session.status)) throw new AppError("browser_allocation_failed", "browser allocation ended");
          if (["ready", "running"].includes(session.status) && session.podName) {
            // Tab contention is governed by the run deadline, not browser allocation timeout.
            while (!await claimBrowserTab(deps.db, tabLease)) {
              if (closed) throw new AppError("browser.disconnected", "browser pool closed");
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            if (closed || released) {
              await releaseBrowserTab(deps.db, tabLease);
              throw new AppError("browser.disconnected", "browser pool closed");
            }
            const url = await deps.workerUrl(session.podName);
            const [latest] = await deps.db.select({ inputOwnerGeneration: browserSessions.inputOwnerGeneration })
              .from(browserSessions).where(eq(browserSessions.id, sessionId));
            let inputGeneration = latest!.inputOwnerGeneration;
            const operationStarts = new Map<string, number>();
            const driver = createCamoufoxWorkerDriver({ token: browserWorkerToken(deps.tokenKey, session.podName), sessionId, generation: session.generation, tabKey: tabLease.tabKey,
              fetch: async (target, init) => {
                const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
                const params = command.params as Record<string, unknown> | undefined;
                const requestedTimeout = typeof params?.timeout === "number" ? params.timeout : 30000;
                // Explicit long waits must finish before their transport deadline. Never accept infinity/zero as an unbounded wait.
                if (params && ["page.wait_for", "page.wait_for_load_state", "page.goto"].includes(String(command.method))) {
                  params.timeout = Math.min(120000, Math.max(1, Number.isFinite(requestedTimeout) ? requestedTimeout : 30000));
                }
                const transportTimeout = Math.max(60000, Number(params?.timeout ?? 30000) + 10000);
                const commandId = newId("command");
                await deps.db.insert(browserCommands).values({ id: commandId, sessionId, runId, runGeneration: row.run.leaseGeneration,
                  generation: session.generation, inputGeneration, method: String(command.method) });
                let dispatched = false;
                let completed = false;
                try {
                  const response = await deps.db.transaction(async (trx) => {
                    await assertRunLease(trx, runId, row.run.leaseGeneration);
                    await assertBrowserTabLease(trx, tabLease);
                    const [owner] = await trx.select().from(browserSessions).where(and(eq(browserSessions.id, sessionId),
                      eq(browserSessions.generation, session.generation), inArray(browserSessions.status, ["ready", "running"]))).for("share");
                    if (!owner || !browserAutomationIsReady(owner)) {
                      throw new AppError("browser_input_revoked", "browser input is paused for a human; wait for resume and perceive again");
                    }
                    if (owner.inputOwnerGeneration !== inputGeneration) {
                      if (!["page.perceive", "browser.version", "tab.acquire", "page.create"].includes(String(command.method))) throw new AppError("browser_fresh_perception_required", "browser input changed; perceive the page before taking another action");
                      if (command.method === "page.perceive") inputGeneration = owner.inputOwnerGeneration;
                    }
                    await trx.update(browserCommands).set({ inputGeneration: owner.inputOwnerGeneration }).where(eq(browserCommands.id, commandId));
                    dispatched = true;
                    const result = await request(target, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(transportTimeout)]) : AbortSignal.timeout(transportTimeout), body: JSON.stringify({ ...command, command_id: commandId, input_generation: owner.inputOwnerGeneration }) });
                    // Consume the body while the lease is locked; headers alone do not mean the action finished.
                    const bytes = await result.arrayBuffer();
                    return new Response(bytes, { status: result.status, headers: result.headers });
                  });
                  const failure = response.ok ? null : await response.clone().json().catch(() => null) as { detail?: { outcomeUncertain?: boolean } } | null;
                  const outcome = response.ok ? "succeeded" : failure?.detail?.outcomeUncertain === false ? "rejected" : "uncertain";
                  await deps.db.update(browserCommands).set({ status: outcome, completedAt: sql`now()` }).where(eq(browserCommands.id, commandId));
                  completed = true;
                  const correlation = currentBrowserOperation();
                  const clock = response.headers.get("x-tabductor-recording-start-ms");
                  const endClock = response.headers.get("x-tabductor-recording-end-ms");
                  const body = response.ok ? await response.clone().json().catch(() => null) as { value?: { pending?: boolean; result?: { ok?: boolean } } } | null : null;
                  const proxy = String(target).endsWith("/automation");
                  if (proxy && command.method === "start" && correlation?.operationId && clock !== null) operationStarts.set(correlation.operationId, Number(clock));
                  const completedOperation = !proxy || command.method === "poll" && body?.value?.pending === false;
                  if (completedOperation && command.method !== "browser.events" && clock !== null && Number.isFinite(Number(clock))) {
                    const operationOutcome = body?.value?.result?.ok === false ? "rejected" : outcome;
                    await deps.db.insert(browserSessionActivity).values({ sessionId, kind: correlation?.member ? `page.${correlation.member}` : String(command.method),
                      offsetMs: Math.max(0, correlation?.operationId ? operationStarts.get(correlation.operationId) ?? Number(clock) : Number(clock)), pageId: typeof command.page_id === "string" ? command.page_id : null,
                      private: response.headers.get("x-tabductor-recording-private") === "true",
                      payloadJson: { commandId, outcome: operationOutcome, clock: "recorder", endMs: Number(endClock ?? clock), ...correlation } });
                    if (correlation?.operationId) operationStarts.delete(correlation.operationId);
                  }
                  if (deps.challengeRecovery !== "agent" && response.ok && command.method === "page.perceive") {
                    const body = await response.clone().json() as { value?: { challenge?: { kind: string; websiteUrl: string; siteKey: string } } };
                    const challenge = body.value?.challenge;
                    if (challenge) {
                      const challengeId = await requestChallengeRecovery(deps.db, { ...challenge, accountId: row.accountId, sessionId });
                      let outcome: "pending" | "solved" | "human_required" = "pending";
                      while (outcome === "pending") {
                        await deps.db.transaction((trx) => assertRunLease(trx, runId, row.run.leaseGeneration));
                        try {
                          outcome = await advanceChallengeRecovery(deps.db, challengeId, deps.solvers ?? [], async (token, details) => deps.db.transaction(async (trx) => {
                            await assertRunLease(trx, runId, row.run.leaseGeneration);
                            await assertBrowserTabLease(trx, tabLease);
                            const [owner] = await trx.select().from(browserSessions).where(eq(browserSessions.id, sessionId)).for("share");
                            if (!owner || !["ready", "running"].includes(owner.status) || owner.generation !== session.generation || !browserAutomationIsReady(owner) || owner.inputOwnerGeneration !== inputGeneration) return false;
                            const applied = await request(target, { ...init, signal: AbortSignal.timeout(15_000), body: JSON.stringify({ generation: session.generation, input_generation: inputGeneration,
                              command_id: newId("command"), method: "challenge.apply", page_id: command.page_id, params: { token, kind: details.kind, site_key: details.siteKey } }) });
                            return applied.ok && (await applied.json() as { value: boolean }).value === true;
                          }));
                        } catch (error) {
                          if (!(error instanceof AppError) || error.code !== "credit_insufficient") throw error;
                          outcome = "human_required";
                        }
                        if (outcome === "pending") await new Promise((resolve) => setTimeout(resolve, 1000));
                      }
                      if (outcome === "human_required") {
                        await requestBrowserTakeover(deps.db, { accountId: row.accountId, sessionId });
                        // Keep the current run alive, with no paid model polling, until explicit resume.
                        for (;;) {
                          await deps.db.transaction((trx) => assertRunLease(trx, runId, row.run.leaseGeneration));
                          const [owner] = await deps.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
                          if (!owner || !["ready", "running"].includes(owner.status)) throw new AppError("browser_input_revoked", "browser session stopped");
                          if (browserAutomationIsReady(owner)) { inputGeneration = owner.inputOwnerGeneration; break; }
                          await new Promise((resolve) => setTimeout(resolve, 500));
                        }
                      }
                      // Return fresh evidence after a solver or human changed the page.
                      const refreshId = newId("command");
                      await deps.db.insert(browserCommands).values({ id: refreshId, sessionId, runId, runGeneration: row.run.leaseGeneration,
                        generation: session.generation, inputGeneration, method: "page.perceive" });
                      let refreshDispatched = false;
                      try {
                        const fresh = await deps.db.transaction(async (trx) => {
                          await assertRunLease(trx, runId, row.run.leaseGeneration);
                          await assertBrowserTabLease(trx, tabLease);
                          const [owner] = await trx.select().from(browserSessions).where(eq(browserSessions.id, sessionId)).for("share");
                          if (!owner || !["ready", "running"].includes(owner.status) || owner.generation !== session.generation || !browserAutomationIsReady(owner) || owner.inputOwnerGeneration !== inputGeneration) {
                            throw new AppError("browser_input_revoked", "browser input changed during recovery");
                          }
                          refreshDispatched = true;
                          const result = await request(target, { ...init, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ ...command,
                            generation: session.generation, input_generation: inputGeneration, command_id: refreshId }) });
                          return new Response(await result.arrayBuffer(), { status: result.status, headers: result.headers });
                        });
                        await deps.db.update(browserCommands).set({ status: fresh.ok ? "succeeded" : "uncertain", completedAt: sql`now()` }).where(eq(browserCommands.id, refreshId));
                        return fresh;
                      } catch (error) {
                        await deps.db.update(browserCommands).set({ status: refreshDispatched ? "uncertain" : "rejected", completedAt: sql`now()` }).where(eq(browserCommands.id, refreshId));
                        throw error;
                      }
                    }
                  }
                  return response;
                } catch (error) {
                  if (!completed) await deps.db.update(browserCommands).set({ status: dispatched ? "uncertain" : "rejected", completedAt: sql`now()` }).where(eq(browserCommands.id, commandId));
                  throw error;
                }
              },
            });
            const conn = await driver.connect(url);
            closeConnection = () => conn.close();
            if (closed || released) { await conn.close(); throw new AppError("browser.disconnected", "browser pool closed"); }
            let agentGeneration = inputGeneration;
            conn.waitForAutomation = async (signal) => {
              for (;;) {
                signal?.throwIfAborted();
                if (closed || !active.has(leaseId)) throw new AppError("browser.disconnected", "browser session ended");
                await deps.db.transaction((trx) => assertRunLease(trx, runId, row.run.leaseGeneration));
                const [owner] = await deps.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
                if (!owner || owner.generation !== session.generation || !["ready", "running"].includes(owner.status)) {
                  throw new AppError("browser.disconnected", "browser session ended");
                }
                if (browserAutomationIsReady(owner)) {
                  const changed = agentGeneration !== owner.inputOwnerGeneration;
                  agentGeneration = owner.inputOwnerGeneration;
                  return changed;
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 250));
              }
            };
            await deps.db.update(browserSessions).set({ status: "running" }).where(and(eq(browserSessions.id, sessionId), eq(browserSessions.status, "ready")));
            return { conn, release };
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new AppError("browser_allocation_timeout", "browser capacity did not become available in time");
      } catch (error) { await release(); throw error; }
    },
    async close() { closed = true; await Promise.allSettled([...active.values()].map((release) => release())); },
  };
}
