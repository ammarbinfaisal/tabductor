import { createHash } from "node:crypto";
import { AppError, newId } from "@tabductor/core";
import { browserChallenges, challengeAttempts, browserSessions, browserSessionActivity, type Db } from "@tabductor/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { reserveCredits, settleCreditReservation } from "./credits.js";

export type ChallengeKind = "recaptcha_v2" | "turnstile";
export type Challenge = { kind: string; websiteUrl: string; siteKey: string };
export type SolverProvider = {
  name: string; rateVersion: string; creditUnits: number; supports: readonly string[];
  submit: (challenge: Challenge) => Promise<{ taskId: string } | { rejected: true }>;
  poll: (taskId: string) => Promise<{ status: "pending" } | { status: "ready"; token: string }>;
};
const capabilities = {
  capsolver: { recaptcha_v2: "ReCaptchaV2TaskProxyLess", turnstile: "AntiTurnstileTaskProxyLess" },
  "2captcha": { recaptcha_v2: "RecaptchaV2TaskProxyless", turnstile: "TurnstileTaskProxyless" },
  "anti-captcha": { recaptcha_v2: "RecaptchaV2TaskProxyless", turnstile: "TurnstileTaskProxyless" },
} as const;
const endpoints = { capsolver: "https://api.capsolver.com", "2captcha": "https://api.2captcha.com", "anti-captcha": "https://api.anti-captcha.com" };

export function parseSolverRates(json?: string) {
  const rates = z.array(z.object({ name: z.enum(["capsolver", "2captcha", "anti-captcha"]),
    rateVersion: z.string().min(1), creditUnits: z.number().int().positive().safe() }).strict()).max(3).parse(JSON.parse(json || "[]"));
  if (new Set(rates.map((rate) => rate.name)).size !== rates.length) throw new AppError("solver_config_invalid", "solver providers must be unique");
  return rates;
}

/** Fixed provider endpoints; secrets and raw provider errors never reach traces or clients. */
export function createSolverProvider(input: { name: keyof typeof capabilities; apiKey: string; rateVersion: string; creditUnits: number; fetch?: typeof fetch }): SolverProvider {
  if (!input.apiKey || !input.rateVersion || !Number.isSafeInteger(input.creditUnits) || input.creditUnits <= 0) throw new AppError("solver_config_invalid", "solver credentials and explicit rates are required");
  const request = async (method: string, fields: Record<string, unknown>) => {
    const response = await (input.fetch ?? fetch)(`${endpoints[input.name]}/${method}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey: input.apiKey, ...fields }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new AppError("solver_outcome_uncertain", "solver response was not acknowledged");
    return await response.json() as { errorId?: number; taskId?: string | number; status?: string; solution?: { token?: string; gRecaptchaResponse?: string } };
  };
  return { name: input.name, rateVersion: input.rateVersion, creditUnits: input.creditUnits, supports: Object.keys(capabilities[input.name]),
    async submit(challenge) {
      const type = capabilities[input.name][challenge.kind as ChallengeKind];
      if (!type) return { rejected: true };
      const result = await request("createTask", { task: { type, websiteURL: challenge.websiteUrl, websiteKey: challenge.siteKey } });
      if (typeof result.errorId === "number" && result.errorId > 0) return { rejected: true };
      if (result.errorId !== 0 || !result.taskId) throw new AppError("solver_outcome_uncertain", "solver did not return a task identifier");
      return { taskId: String(result.taskId) };
    },
    async poll(taskId) {
      const result = await request("getTaskResult", { taskId: input.name === "capsolver" ? taskId : Number(taskId) });
      if (result.errorId !== 0) throw new AppError("solver_outcome_uncertain", "solver outcome requires reconciliation");
      if (result.status === "processing" || result.status === "idle") return { status: "pending" };
      const token = result.solution?.gRecaptchaResponse ?? result.solution?.token;
      if (result.status !== "ready" || !token) throw new AppError("solver_outcome_uncertain", "solver returned no usable solution");
      return { status: "ready", token };
    },
  };
}

export async function requestChallengeRecovery(db: Db, input: Challenge & { accountId: string; sessionId: string }): Promise<string> {
  const url = new URL(input.websiteUrl);
  if (!["https:", "http:"].includes(url.protocol) || input.siteKey.length > 1000) throw new AppError("challenge_invalid", "invalid challenge");
  // URL parameters may contain credentials; providers need the page's origin/path only.
  const websiteUrl = url.origin + url.pathname;
  const identity = createHash("sha256").update(JSON.stringify([input.kind, websiteUrl, input.siteKey])).digest("hex");
  return db.transaction(async (trx) => {
    const [session] = await trx.select().from(browserSessions).where(and(eq(browserSessions.id, input.sessionId), eq(browserSessions.accountId, input.accountId))).for("update");
    if (!session || !["ready", "running"].includes(session.status) || session.inputOwner !== "ai") throw new AppError("browser_input_revoked", "challenge recovery requires an active automation session");
    const [existing] = await trx.select().from(browserChallenges).where(and(eq(browserChallenges.sessionId, input.sessionId), eq(browserChallenges.identity, identity)));
    if (existing) return existing.id;
    const id = newId("challenge");
    await trx.insert(browserChallenges).values({ id, sessionId: input.sessionId, accountId: input.accountId, identity, kind: input.kind, websiteUrl, siteKey: input.siteKey, deadline: new Date(Date.now() + 120_000) });
    return id;
  });
}

/** One durable step. Submission ambiguity requests a human; it never buys a second attempt. */
export async function advanceChallengeRecovery(db: Db, id: string, providers: readonly SolverProvider[],
  applyAndVerify: (token: string, challenge: Challenge) => Promise<boolean>): Promise<"pending" | "solved" | "human_required"> {
  const now = Date.now();
  const claimed = await db.transaction(async (trx) => {
    const [challenge] = await trx.select().from(browserChallenges).where(eq(browserChallenges.id, id)).for("update");
    if (!challenge) throw new AppError("challenge_not_found", "challenge not found");
    if (challenge.status !== "pending") return { challenge, terminal: true as const };
    const [session] = await trx.select().from(browserSessions).where(eq(browserSessions.id, challenge.sessionId));
    if (!session || !["ready", "running"].includes(session.status) || session.inputOwner !== "ai") {
      await trx.update(browserChallenges).set({ status: "human_required" }).where(eq(browserChallenges.id, id));
      return { challenge: { ...challenge, status: "human_required" as const }, terminal: true as const };
    }
    if (challenge.nextPollAt.getTime() > now) return { challenge, waiting: true as const };
    const [previous] = await trx.select().from(challengeAttempts).where(eq(challengeAttempts.challengeId, id)).orderBy(desc(challengeAttempts.createdAt)).limit(1);
    const available = providers.filter((provider) => provider.supports.includes(challenge.kind));
    if (challenge.deadline.getTime() <= now || !available.length || previous && ["submitting", "uncertain", "applying"].includes(previous.status) || challenge.attempts >= 3 && previous?.status !== "submitted") {
      await trx.update(browserChallenges).set({ status: "human_required" }).where(eq(browserChallenges.id, id));
      await trx.insert(browserSessionActivity).values({ sessionId: challenge.sessionId, kind: "challenge_human_required", private: true, payloadJson: { challengeId: id } });
      return { challenge: { ...challenge, status: "human_required" as const }, terminal: true as const };
    }
    // The claim exceeds the provider RPC timeout. A crashed submission remains uncertain.
    await trx.update(browserChallenges).set({ nextPollAt: new Date(now + 20_000) }).where(eq(browserChallenges.id, id));
    if (previous?.status === "submitted") return { challenge, attempt: previous, provider: available.find((provider) => provider.name === previous.provider), poll: true as const };
    const provider = available[challenge.attempts % available.length]!;
    const attemptId = newId("solver");
    const reservation = await reserveCredits(trx, { accountId: challenge.accountId, category: "solver", operationId: attemptId, units: provider.creditUnits });
    const [attempt] = await trx.insert(challengeAttempts).values({ id: attemptId, challengeId: id, provider: provider.name, rateVersion: provider.rateVersion,
      creditUnits: provider.creditUnits, reservationId: reservation.id, status: "submitting" }).returning();
    await trx.update(browserChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(browserChallenges.id, id));
    await trx.insert(browserSessionActivity).values({ sessionId: challenge.sessionId, kind: "challenge_submitted", payloadJson: { challengeId: id, provider: provider.name, reservedUnits: provider.creditUnits } });
    return { challenge, attempt: attempt!, provider, poll: false as const };
  });
  if ("terminal" in claimed) return claimed.challenge.status;
  if ("waiting" in claimed) return "pending";
  const { challenge, attempt, provider } = claimed;
  try {
    if (!provider) throw new Error("provider configuration unavailable");
    if (!claimed.poll) {
      const result = await provider.submit(challenge);
      await db.transaction(async (trx) => {
        if ("rejected" in result) {
          await settleCreditReservation(trx, { accountId: challenge.accountId, reservationId: attempt.reservationId, actualUnits: 0 });
          await trx.update(challengeAttempts).set({ status: "rejected" }).where(eq(challengeAttempts.id, attempt.id));
        } else await trx.update(challengeAttempts).set({ status: "submitted", providerTaskId: result.taskId }).where(eq(challengeAttempts.id, attempt.id));
        await trx.update(browserChallenges).set({ nextPollAt: new Date(Date.now() + 5000) }).where(eq(browserChallenges.id, id));
      });
      return "pending";
    }
    const result = await provider.poll(attempt.providerTaskId!);
    if (result.status === "pending") {
      await db.update(browserChallenges).set({ nextPollAt: new Date(Date.now() + 5000) }).where(eq(browserChallenges.id, id));
      return "pending";
    }
    await db.transaction(async (trx) => {
      await settleCreditReservation(trx, { accountId: challenge.accountId, reservationId: attempt.reservationId, actualUnits: attempt.creditUnits });
      await trx.update(challengeAttempts).set({ status: "applying" }).where(eq(challengeAttempts.id, attempt.id));
    });
    const [session] = await db.select().from(browserSessions).where(eq(browserSessions.id, challenge.sessionId));
    if (challenge.deadline.getTime() <= Date.now() || !session || !["ready", "running"].includes(session.status) || session.inputOwner !== "ai") throw new Error("challenge no longer active");
    const solved = await applyAndVerify(result.token, challenge);
    await db.transaction(async (trx) => {
      await trx.update(challengeAttempts).set({ status: solved ? "solved" : "invalid" }).where(eq(challengeAttempts.id, attempt.id));
      await trx.update(browserChallenges).set({ ...(solved ? { status: "solved" as const } : {}), nextPollAt: new Date() }).where(eq(browserChallenges.id, id));
      await trx.insert(browserSessionActivity).values({ sessionId: challenge.sessionId, kind: solved ? "challenge_solved" : "challenge_invalid", payloadJson: { challengeId: id, chargedUnits: attempt.creditUnits } });
    });
    return solved ? "solved" : "pending";
  } catch {
    await db.transaction(async (trx) => {
      await trx.update(challengeAttempts).set({ status: "uncertain" }).where(eq(challengeAttempts.id, attempt.id));
      await trx.update(browserChallenges).set({ status: "human_required" }).where(eq(browserChallenges.id, id));
    });
    return "human_required";
  }
}
