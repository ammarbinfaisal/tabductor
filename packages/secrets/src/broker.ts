import { and, eq } from "drizzle-orm";
import { AppError } from "@tabductor/core";
import type { RunSession, TargetProbe } from "@tabductor/browser";
import type { TraceRecorder } from "@tabductor/browser";
import {
  runs,
  secretAccessLog,
  secrets,
  tasks,
  workflowVersions,
  workflows,
  type Db,
  type SecretAccessAction,
  type SecretRow,
} from "@tabductor/db";
import type { Metrics } from "@tabductor/telemetry";
import { unsealValue, zero, type KeyWrapper } from "./crypto.js";

/**
 * THE SECRETS BROKER (§16 Threat 4). Its public, tool-adjacent surface — the `SecretsBroker`
 * type below — is exactly one method:
 *
 *   fill(runId, secretName, anchor): Promise<{ok: true}>
 *
 * **There is no `get(name): string` here, or anywhere else in this codebase, ever.** That
 * absence is the primary control, not an oversight to fill in later — a function that hands a
 * caller a plaintext secret by name is the one shape this module is built to make impossible.
 * Decryption happens only inside `fill`, for exactly one `insertTextRaw` call. Every plaintext
 * buffer this file produces is zeroed in a `finally` the
 * instant its one use is over. `leak-lint` (`scripts/leak-lint.mjs`, wired into `pnpm lint`)
 * greps the whole tree for the shape of a function that would violate this; this comment is
 * the human-readable half of that guard.
 *
 * `fill` throws a typed `AppError` on refusal rather than returning a
 * union type — there is no `{ok: false}` in `fill`'s return type at all. Which of these a
 * future tool wrapper (S5c) treats as a recoverable tool error versus a run-ending failure is
 * its call to make (the rate-limit case is deliberately meant to kill the run — a loop of
 * fills is character-probing exfiltration, not a login, per §16).
 */

const ALLOWED_INPUT_TYPES = new Set(["text", "password", "email"]);
const DEFAULT_MAX_FILLS_PER_RUN = 3;
export type SecretsBrokerRunDeps = { session: RunSession; trace: TraceRecorder };

export type SecretsBroker = {
  fill(runId: string, secretName: string, anchor: string): Promise<{ ok: true }>;
};

export type SecretsBrokerDeps = {
  db: Db;
  keyWrapper: KeyWrapper;
  /**
   * Resolves the live browser session/trace for a run. The broker owns no session lifecycle
   * of its own — whatever composition root opens a run's session (S4b's `AgentExecutor`,
   * wiring) registers it here before an agent's `fill` call can reach it. `undefined`
   * means "no such run" as far as `fill` is concerned.
   */
  resolveRun: (runId: string) => SecretsBrokerRunDeps | undefined;
  metrics?: Metrics;
  /** Ceiling on fills per run (default 3). A task may only lower this, never raise it
   * (`S5b-secrets-broker.md`) — that enforcement is the caller's, this is just the default. */
  maxFillsPerRun?: number;
};

export type SecretsBrokerHandle = SecretsBroker;

export function createSecretsBroker(deps: SecretsBrokerDeps): SecretsBrokerHandle {
  const { db, keyWrapper, resolveRun, metrics } = deps;
  const maxFillsPerRun = deps.maxFillsPerRun ?? DEFAULT_MAX_FILLS_PER_RUN;

  // Per-run fill counts are bookkeeping, not a cache of anything decrypted.
  const fillCounts = new Map<string, number>();

  const logAccess = async (
    runId: string,
    secretName: string,
    action: SecretAccessAction,
    anchor: string | null,
  ): Promise<void> => {
    await db.insert(secretAccessLog).values({ runId, secretName, action, anchor });
  };

  /** Scopes a secret lookup to the run's own owning user — `fill` takes no
   * `userId` themselves, so this join (run → task → workflow version → workflow.user_id) is
   * what stands in for it, matching `secrets`' `unique(user_id, name)` constraint. */
  const resolveSecretForRun = async (
    runId: string,
    secretName: string,
  ): Promise<{ secret: SecretRow } | undefined> => {
    const rows = await db
      .select({ secret: secrets })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .innerJoin(secrets, and(eq(secrets.userId, workflows.userId), eq(secrets.name, secretName)))
      .where(eq(runs.id, runId))
      .limit(1);
    return rows[0];
  };

  /** One refusal path for every kind of `fill` denial: logs the access row, traces
   * `policy_denied` (never the value — `secretName`/`anchor`/`rule` only, the same shape
   * `session.ts`'s own denials use), bumps the metric, and throws. */
  const refuseFill = async (
    run: SecretsBrokerRunDeps,
    runId: string,
    secretName: string,
    anchor: string,
    action: SecretAccessAction,
    metricOutcome: "denied_origin" | "denied_grant" | "denied_target" | "rate_limited",
    message: string,
  ): Promise<never> => {
    await logAccess(runId, secretName, action, anchor);
    await run.trace.record("policy_denied", { check: "secrets.fill", secretName, anchor, rule: action });
    metrics?.secretFills.add({ outcome: metricOutcome });
    throw new AppError(`secret_${metricOutcome}`, message, { details: { secretName, anchor, rule: action } });
  };

  const decryptSecret = async (secret: SecretRow): Promise<Buffer> => {
    const dek = await keyWrapper.unwrap(Buffer.from(secret.dekWrapped, "base64"), secret.kekRef);
    try {
      return unsealValue(dek, {
        ciphertext: Buffer.from(secret.ciphertext, "base64"),
        nonce: Buffer.from(secret.nonce, "base64"),
      });
    } finally {
      zero(dek);
    }
  };

  /** `null` when `probe.type` is absent — an `<input>` with no `type` attribute is a text
   * field by HTML's own default, so "absent" and `"text"` mean the same thing here. */
  const targetDenialAction = (probe: TargetProbe, pageOrigin: string): SecretAccessAction | null => {
    if (probe.frameOrigin !== pageOrigin) return "denied_target_cross_origin_frame";
    if (probe.contentEditable) return "denied_target_contenteditable";
    if (probe.tag !== "input") return "denied_target_type";
    const type = probe.type ?? "text";
    if (type === "hidden") return "denied_target_hidden";
    if (!ALLOWED_INPUT_TYPES.has(type)) return "denied_target_type";
    return null;
  };

  return {
    async fill(runId, secretName, anchor) {
      const run = resolveRun(runId);
      if (!run) {
        throw new AppError("secret_run_not_found", `no live session for run ${runId}`, {
          details: { runId },
        });
      }

      const resolved = await resolveSecretForRun(runId, secretName);
      if (!resolved) {
        return refuseFill(
          run,
          runId,
          secretName,
          anchor,
          "denied_target_not_found",
          "denied_target",
          `no secret named "${secretName}" for this run's user`,
        );
      }
      const { secret } = resolved;

      // 1. Origin binding (§16): the page's *live* origin, asked of the driver — never the
      // task's nav allowlist, which is a different control for a different threat.
      const pageOrigin = new URL(run.session.page.url()).origin;
      if (!secret.allowedOrigins.includes(pageOrigin)) {
        return refuseFill(
          run,
          runId,
          secretName,
          anchor,
          "denied_origin",
          "denied_origin",
          `"${secretName}" is not allowed to fill on origin ${pageOrigin}`,
        );
      }

      // 2. Target validation: the anchor must resolve, and resolve to an allowed input in a
      // same-origin frame — never a hidden field, contenteditable, or cross-origin iframe.
      const locator = run.session.resolveAnchor(anchor);
      if (locator === undefined) {
        return refuseFill(
          run,
          runId,
          secretName,
          anchor,
          "denied_target_not_found",
          "denied_target",
          `anchor "${anchor}" does not resolve against the most recent perception`,
        );
      }
      const probe = await run.session.page.probeTarget(locator);
      const denial = probe === null ? "denied_target_not_found" : targetDenialAction(probe, pageOrigin);
      if (denial !== null) {
        return refuseFill(run, runId, secretName, anchor, denial, "denied_target", `target refused: ${denial}`);
      }

      // 3. Rate limit: a loop of fills is character-probing exfiltration, not a login.
      const soFar = fillCounts.get(runId) ?? 0;
      if (soFar >= maxFillsPerRun) {
        return refuseFill(
          run,
          runId,
          secretName,
          anchor,
          "rate_limited",
          "rate_limited",
          `run ${runId} already used its ${maxFillsPerRun} fills`,
        );
      }
      fillCounts.set(runId, soFar + 1);

      // 4. Decrypt for exactly one insertion, then zero — no matter how it goes.
      const plaintext = await decryptSecret(secret);
      try {
        await run.session.page.insertTextRaw(locator, plaintext.toString("utf8"));
      } catch (err) {
        await logAccess(runId, secretName, "insert_failed", anchor);
        await run.trace.record("action", {
          action: "secrets.fill",
          secretName,
          anchor,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        zero(plaintext);
      }

      await logAccess(runId, secretName, "filled", anchor);
      await run.trace.record("action", { action: "secrets.fill", secretName, anchor, ok: true });
      metrics?.secretFills.add({ outcome: "filled" });
      return { ok: true };
    },
  };
}
