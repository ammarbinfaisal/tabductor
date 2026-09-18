import { requestChallengeRecovery, advanceChallengeRecovery, type SolverProvider } from "./challenge-recovery.js";
import { createHmac } from "node:crypto";
import { AppError, newId } from "@tabductor/core";
import type { EndpointPool } from "@tabductor/browser";
import { createCamoufoxWorkerDriver } from "@tabductor/browser/worker-driver";
import { browserSessionActivity, browserSessions, browserCommands, workflowBrowserProfiles, workflows, runs, workflowVersions, tasks, browserBilling, type Db } from "@tabductor/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createBrowserProfile, requestBrowserSession, type BrowserAdmission } from "./browser-fleet.js";
import { requestBrowserTakeover, stopBrowserSession } from "./browser-session-control.js";
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
  if (!rate.version || !Number.isSafeInteger(rate.unitsPerMinute) || rate.unitsPerMinute <= 0 || !Number.isSafeInteger(rate.maxSeconds) || rate.maxSeconds < 60 || rate.maxSeconds > 86400) {
    throw new AppError("browser_rate_invalid", "browser allocation requires a versioned rate and a bounded session duration");
  }
  return { async reserve(input, trx) {
    const reservation = await reserveCredits(trx, { accountId: input.accountId, operationId: `browser:${input.sessionId}`, category: "browser", units: Math.ceil(rate.maxSeconds / 60) * rate.unitsPerMinute, ttlMs: 86400_000 });
    await trx.insert(browserBilling).values({ sessionId: input.sessionId, reservationId: reservation.id, rateVersion: rate.version, unitsPerMinute: rate.unitsPerMinute, maxSeconds: rate.maxSeconds });
  } };
}

export async function settleBrowserUsage(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const [session] = await trx.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
    const [billing] = await trx.select().from(browserBilling).where(eq(browserBilling.sessionId, sessionId)).for("update");
    if (!billing || billing.endedAt || !session?.endedAt) return;
    const seconds = Math.min(billing.maxSeconds, Math.max(0, (session.endedAt.getTime() - billing.startedAt.getTime()) / 1000));
    await settleCreditReservation(trx, { accountId: session.accountId, reservationId: billing.reservationId,
      actualUnits: Math.ceil(seconds / 60) * billing.unitsPerMinute });
    await trx.update(browserBilling).set({ endedAt: session.endedAt }).where(eq(browserBilling.sessionId, sessionId));
  });
}

/** The engine's hosted pool has the same executor interface as the development CDP pool. */
export function createHostedBrowserPool(deps: { db: Db; tokenKey: string; workerUrl: (podName: string) => Promise<string>;
  solvers?: readonly SolverProvider[]; fetch?: typeof fetch; allocationTimeoutMs?: number }): EndpointPool {
  let closed = false;
  const active = new Map<string, () => Promise<void>>();
  const request = deps.fetch ?? fetch;
  return {
    async acquire(_endpointId, runId) {
      const [row] = await deps.db.select({ run: runs, accountId: workflows.accountId, workflowId: workflows.id }).from(runs)
        .innerJoin(tasks, eq(tasks.id, runs.taskId)).innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
        .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId)).where(eq(runs.id, runId));
      if (!row || !row.run.executionId || row.run.status !== "running") throw new AppError("run_lease_lost", "active execution is required for a hosted browser");
      const profileId = await ensureWorkflowBrowserProfile(deps.db, row.accountId, row.workflowId);
      const sessionId = await requestBrowserSession(deps.db, { accountId: row.accountId, profileId, executionId: row.run.executionId });
      const release = async () => { await stopBrowserSession(deps.db, { accountId: row.accountId, sessionId }); active.delete(sessionId); };
      active.set(sessionId, release);
      const started = Date.now();
      try {
        while (!closed && Date.now() - started < (deps.allocationTimeoutMs ?? 120_000)) {
          await deps.db.transaction((trx) => assertRunLease(trx, runId, row.run.leaseGeneration));
          const [session] = await deps.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
          if (!session || ["ended", "failed", "stopping"].includes(session.status)) throw new AppError("browser_allocation_failed", "browser allocation ended");
          if (session.status === "ready" && session.podName) {
            const url = await deps.workerUrl(session.podName);
            let inputGeneration = session.inputOwnerGeneration;
            const driver = createCamoufoxWorkerDriver({ token: browserWorkerToken(deps.tokenKey, session.podName), sessionId, generation: session.generation,
              fetch: async (target, init) => {
                const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
                const commandId = newId("command");
                await deps.db.insert(browserCommands).values({ id: commandId, sessionId, runId, runGeneration: row.run.leaseGeneration,
                  generation: session.generation, inputGeneration, method: String(command.method) });
                let dispatched = false;
                let completed = false;
                try {
                  const response = await deps.db.transaction(async (trx) => {
                    await assertRunLease(trx, runId, row.run.leaseGeneration);
                    const [owner] = await trx.select().from(browserSessions).where(and(eq(browserSessions.id, sessionId),
                      eq(browserSessions.generation, session.generation), inArray(browserSessions.status, ["ready", "running"]))).for("update");
                    if (!owner || owner.inputOwner !== "ai") {
                      throw new AppError("browser_input_revoked", "browser input is paused for a human; wait for resume and perceive again");
                    }
                    if (owner.inputOwnerGeneration !== inputGeneration) {
                      if (command.method !== "page.perceive") throw new AppError("browser_fresh_perception_required", "browser input changed; perceive the page before taking another action");
                      inputGeneration = owner.inputOwnerGeneration;
                    }
                    dispatched = true;
                    const result = await request(target, { ...init, signal: AbortSignal.timeout(60_000), body: JSON.stringify({ ...command, command_id: commandId, input_generation: owner.inputOwnerGeneration }) });
                    // Consume the body while the lease is locked; headers alone do not mean the action finished.
                    const bytes = await result.arrayBuffer();
                    return new Response(bytes, { status: result.status, headers: result.headers });
                  });
                  await deps.db.update(browserCommands).set({ status: response.ok ? "succeeded" : "uncertain", completedAt: sql`now()` }).where(eq(browserCommands.id, commandId));
                  completed = true;
                  await deps.db.insert(browserSessionActivity).values({ sessionId, kind: String(command.method),
                    offsetMs: Math.max(0, Date.now() - (session.readyAt ?? session.createdAt).getTime()),
                    private: command.method === "page.insert_text", payloadJson: { commandId, outcome: response.ok ? "succeeded" : "uncertain" } });
                  if (response.ok && command.method === "page.perceive") {
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
                            const [owner] = await trx.select().from(browserSessions).where(eq(browserSessions.id, sessionId)).for("update");
                            if (!owner || !["ready", "running"].includes(owner.status) || owner.generation !== session.generation || owner.inputOwner !== "ai" || owner.inputOwnerGeneration !== inputGeneration) return false;
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
                          if (owner.inputOwner === "ai") { inputGeneration = owner.inputOwnerGeneration; break; }
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
                          const [owner] = await trx.select().from(browserSessions).where(eq(browserSessions.id, sessionId)).for("update");
                          if (!owner || !["ready", "running"].includes(owner.status) || owner.generation !== session.generation || owner.inputOwner !== "ai" || owner.inputOwnerGeneration !== inputGeneration) {
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
            await deps.db.update(browserSessions).set({ status: "running" }).where(and(eq(browserSessions.id, sessionId), eq(browserSessions.status, "ready")));
            return { conn, release: async () => { await conn.close(); await release(); } };
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new AppError("browser_allocation_timeout", "browser capacity did not become available in time");
      } catch (error) { await release(); throw error; }
    },
    async close() { closed = true; await Promise.allSettled([...active.values()].map((release) => release())); },
  };
}
