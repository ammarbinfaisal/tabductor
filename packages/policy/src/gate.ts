import { publish } from "@tabductor/bus";
import { loadConfig, newId } from "@tabductor/core";
import {
  accountBaselineRules,
  approvals,
  runs,
  secretGrants,
  storeWriteGrants,
  taskGrants,
  tasks,
  workflowVersions,
  workflows,
  type ApprovalRow,
  type Db,
  type TaskGrantRow,
} from "@tabductor/db";
import { and, eq, sql } from "drizzle-orm";
import { minimatch } from "minimatch";
import { z } from "zod";

/**
 * The one architectural precondition (impl-phases §0): every action in every phase routes
 * through this interface, so Phase 7 swaps the implementation with no call-site changes.
 * The types below stay deliberately loose — the browser/agent/MCP packages that own these
 * shapes do not exist yet, and inventing them here would be speculation.
 */

export type TaskCtx = { taskId: string; runId: string; grants?: unknown };

export type Verdict = { allow: true } | { allow: false; rule: string };

export type BrowserAction = { kind: string; [k: string]: unknown };
export type NavCause = "initial" | "redirect" | "window_open" | "script";
export type ReqRef = { index: number; url: string };
export type ReadParts = { headers?: boolean; body?: boolean };
export type NetworkPayload = { headers?: Record<string, string>; body?: string };

export interface PolicyGate {
  checkAction(taskCtx: TaskCtx, action: BrowserAction): Promise<Verdict>;
  checkNavigation(taskCtx: TaskCtx, url: URL, cause: NavCause): Promise<Verdict>;
  checkNetworkRead(taskCtx: TaskCtx, req: ReqRef, parts: ReadParts): Promise<Verdict>;
  checkSecretUse(taskCtx: TaskCtx, secretName: string): Promise<Verdict>;
  checkStoreWrite(taskCtx: TaskCtx, table: string): Promise<Verdict>;
  redact(taskCtx: TaskCtx, payload: NetworkPayload): Promise<NetworkPayload>;
}

const ALLOW: Verdict = { allow: true };

/** `x.com` matches `x.com` and `api.x.com`, never `notx.com`. */
function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Permissive gate for Phases 1–6. The single carve-out (impl-phases §0.1) is the
 * `HARNESS_NAV_ALLOWLIST` domain check, which keeps a confused agent from wandering a
 * logged-in browser off the fixtures during development. Empty/unset allowlist = allow all.
 */
export class AllowAllGate implements PolicyGate {
  private readonly navAllowlist: readonly string[];

  constructor(opts: { navAllowlist?: readonly string[] } = {}) {
    this.navAllowlist = opts.navAllowlist ?? loadConfig().HARNESS_NAV_ALLOWLIST;
  }

  async checkAction(_taskCtx: TaskCtx, _action: BrowserAction): Promise<Verdict> {
    return ALLOW;
  }

  async checkNavigation(_taskCtx: TaskCtx, url: URL, _cause: NavCause): Promise<Verdict> {
    if (this.navAllowlist.length === 0) return ALLOW;
    if (hostAllowed(url.hostname, this.navAllowlist)) return ALLOW;
    return { allow: false, rule: "harness_nav_allowlist" };
  }

  async checkNetworkRead(_taskCtx: TaskCtx, _req: ReqRef, _parts: ReadParts): Promise<Verdict> {
    return ALLOW;
  }

  async checkSecretUse(_taskCtx: TaskCtx, _secretName: string): Promise<Verdict> {
    return ALLOW;
  }

  async checkStoreWrite(_taskCtx: TaskCtx, _table: string): Promise<Verdict> {
    return ALLOW;
  }

  async redact(_taskCtx: TaskCtx, payload: NetworkPayload): Promise<NetworkPayload> {
    return payload;
  }
}

/** Hosted runtime policy: actions need no user grants, while trace/network data is redacted. */
export class RuntimeSafetyGate extends AllowAllGate {
  private readonly tokenPatterns: readonly RegExp[];

  constructor(opts: { navAllowlist?: readonly string[]; tokenPatterns?: readonly RegExp[] } = {}) {
    super({ ...(opts.navAllowlist ? { navAllowlist: opts.navAllowlist } : {}) });
    this.tokenPatterns = opts.tokenPatterns ?? DEFAULT_TOKEN_PATTERNS;
  }

  override async redact(_taskCtx: TaskCtx, payload: NetworkPayload): Promise<NetworkPayload> {
    const headers = payload.headers
      ? Object.fromEntries(Object.entries(payload.headers).map(([name, value]) => {
          const lower = name.toLowerCase();
          const sensitive = lower === "authorization" || lower === "cookie" || lower === "set-cookie";
          return [name, sensitive ? "[REDACTED]" : maskText(value, this.tokenPatterns)];
        }))
      : undefined;
    return {
      ...(headers ? { headers } : {}),
      ...(payload.body !== undefined ? { body: maskText(payload.body, this.tokenPatterns) } : {}),
    };
  }
}

export const GRANT_KEYS = [
  "navigation",
  "action",
  "network.headers",
  "network.body",
  "secret.use",
  "secrets.read",
  "store.write",
] as const;
export type GrantKey = (typeof GRANT_KEYS)[number];

export const baselineRuleSchema = z.object({
  effect: z.enum(["deny", "require_approval"]),
  grantKey: z.enum(GRANT_KEYS),
  value: z.string().min(1),
});
export type BaselineRule = z.infer<typeof baselineRuleSchema>;

export type DatabasePolicyGateOptions = {
  db: Db;
  navigationMode?: "permissive" | "grant_required";
  approvalTtlMs?: number;
  approvalPollMs?: number;
  tokenPatterns?: readonly RegExp[];
};

type PolicyRequest = {
  key: GrantKey;
  value: string;
  check: string;
  diagnostic: Record<string, unknown>;
  defaultAllow: boolean;
};

const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
const DEFAULT_APPROVAL_POLL_MS = 250;
const DEFAULT_TOKEN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]+/gi,
];

export function grantValueMatches(key: GrantKey, pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (key === "navigation") {
    const host = value.toLowerCase();
    const allowed = pattern.toLowerCase();
    if (allowed.includes("*")) return minimatch(host, allowed);
    return host === allowed || host.endsWith(`.${allowed}`);
  }
  return minimatch(value, pattern, { dot: true, nocase: false });
}

function maskText(value: string, patterns: readonly RegExp[]): string {
  let masked = value;
  for (const pattern of patterns) masked = masked.replace(pattern, "[REDACTED]");
  return masked;
}

/**
 * The S7 evaluator. Account baseline rules are checked before task grants and therefore
 * cannot be overridden. Basic page actions and network bodies remain default-allow during
 * migration. Navigation is default-allow unless grant_required mode is selected;
 * headers, secrets, and store writes require an explicit grant.
 */
export class DatabasePolicyGate implements PolicyGate {
  private readonly db: Db;
  private readonly navigationMode: "permissive" | "grant_required";
  private readonly approvalTtlMs: number;
  private readonly approvalPollMs: number;
  private readonly tokenPatterns: readonly RegExp[];

  constructor(opts: DatabasePolicyGateOptions) {
    this.db = opts.db;
    this.navigationMode = opts.navigationMode ?? "permissive";
    this.approvalTtlMs = opts.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.approvalPollMs = opts.approvalPollMs ?? DEFAULT_APPROVAL_POLL_MS;
    this.tokenPatterns = opts.tokenPatterns ?? DEFAULT_TOKEN_PATTERNS;
  }

  async checkAction(taskCtx: TaskCtx, action: BrowserAction): Promise<Verdict> {
    const kind = String(action.kind);
    const sensitive =
      kind === "upload" || kind === "download" || kind === "page.upload" || kind === "page.download";
    return this.evaluate(taskCtx, {
      key: "action",
      value: kind,
      check: "action",
      diagnostic: { action: kind },
      defaultAllow: !sensitive,
    });
  }

  async checkNavigation(taskCtx: TaskCtx, url: URL, cause: NavCause): Promise<Verdict> {
    return this.evaluate(taskCtx, {
      key: "navigation",
      value: url.hostname,
      check: "navigation",
      diagnostic: { host: url.hostname, cause },
      defaultAllow: this.navigationMode === "permissive",
    });
  }

  async checkNetworkRead(taskCtx: TaskCtx, _req: ReqRef, parts: ReadParts): Promise<Verdict> {
    const key: GrantKey = parts.headers ? "network.headers" : "network.body";
    return this.evaluate(taskCtx, {
      key,
      value: "*",
      check: "network_read",
      diagnostic: { parts },
      defaultAllow: key === "network.body",
    });
  }

  async checkSecretUse(taskCtx: TaskCtx, secretName: string): Promise<Verdict> {
    const [grant] = await this.db
      .select({ secretName: secretGrants.secretName })
      .from(secretGrants)
      .where(and(eq(secretGrants.taskId, taskCtx.taskId), eq(secretGrants.secretName, secretName)))
      .limit(1);
    if (!grant) {
      return this.deny(taskCtx, "grant_missing:secret.use", {
        key: "secret.use",
        value: secretName,
        check: "secret_use",
        diagnostic: { secretName },
        defaultAllow: false,
      });
    }
    return this.evaluate(taskCtx, {
      key: "secret.use",
      value: secretName,
      check: "secret_use",
      diagnostic: { secretName },
      defaultAllow: true,
    });
  }

  async checkStoreWrite(taskCtx: TaskCtx, table: string): Promise<Verdict> {
    const grants = await this.db
      .select({ tableName: storeWriteGrants.tableName })
      .from(storeWriteGrants)
      .where(eq(storeWriteGrants.taskId, taskCtx.taskId));
    if (!grants.some((grant) => grant.tableName === table)) {
      return this.deny(taskCtx, "grant_missing:store.write", {
        key: "store.write",
        value: table,
        check: "store_write",
        diagnostic: { table },
        defaultAllow: false,
      });
    }
    return this.evaluate(taskCtx, {
      key: "store.write",
      value: table,
      check: "store_write",
      diagnostic: { table },
      defaultAllow: true,
    });
  }

  async redact(taskCtx: TaskCtx, payload: NetworkPayload): Promise<NetworkPayload> {
    const secretVerdict = await this.evaluate(taskCtx, {
      key: "secrets.read",
      value: "*",
      check: "redaction",
      diagnostic: {},
      defaultAllow: false,
    }, false, false);
    if (secretVerdict.allow) return payload;

    const headers = payload.headers
      ? Object.fromEntries(
          Object.entries(payload.headers).map(([name, value]) => {
            const lower = name.toLowerCase();
            const sensitive = lower === "authorization" || lower === "cookie" || lower === "set-cookie";
            return [name, sensitive ? "[REDACTED]" : maskText(value, this.tokenPatterns)];
          }),
        )
      : undefined;
    return {
      ...(headers ? { headers } : {}),
      ...(payload.body !== undefined ? { body: maskText(payload.body, this.tokenPatterns) } : {}),
    };
  }

  private async policyRows(taskId: string): Promise<{
    grants: TaskGrantRow[];
    rules: BaselineRule[];
    baselineInvalid: boolean;
  }> {
    const [grants, baseline] = await Promise.all([
      this.db.select().from(taskGrants).where(eq(taskGrants.taskId, taskId)),
      this.db
        .select({ ruleJson: accountBaselineRules.ruleJson })
        .from(tasks)
        .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
        .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
        .innerJoin(accountBaselineRules, eq(accountBaselineRules.userId, workflows.userId))
        .where(eq(tasks.id, taskId)),
    ]);
    const parsed = baseline.map(({ ruleJson }) => baselineRuleSchema.safeParse(ruleJson));
    return {
      grants,
      rules: parsed.filter((row): row is z.SafeParseSuccess<BaselineRule> => row.success).map((row) => row.data),
      baselineInvalid: parsed.some((row) => !row.success),
    };
  }

  private async evaluate(
    taskCtx: TaskCtx,
    request: PolicyRequest,
    waitForApproval = true,
    recordDenial = true,
  ): Promise<Verdict> {
    const { grants, rules, baselineInvalid } = await this.policyRows(taskCtx.taskId);
    if (baselineInvalid) {
      return recordDenial
        ? this.deny(taskCtx, "baseline_invalid", request)
        : { allow: false, rule: "baseline_invalid" };
    }

    const denied = rules.find(
      (rule) => rule.effect === "deny" && rule.grantKey === request.key && grantValueMatches(request.key, rule.value, request.value),
    );
    if (denied) {
      const rule = `baseline_deny:${request.key}:${denied.value}`;
      return recordDenial ? this.deny(taskCtx, rule, request) : { allow: false, rule };
    }

    const matchingGrants = grants.filter(
      (row) => row.grantKey === request.key && grantValueMatches(request.key, row.grantValue, request.value),
    );
    if (matchingGrants.length === 0 && !request.defaultAllow) {
      const rule = `grant_missing:${request.key}`;
      return recordDenial ? this.deny(taskCtx, rule, request) : { allow: false, rule };
    }

    const baselineApproval = rules.find(
      (rule) =>
        rule.effect === "require_approval" &&
        rule.grantKey === request.key &&
        grantValueMatches(request.key, rule.value, request.value),
    );
    if (waitForApproval && (matchingGrants.some((grant) => grant.requiresApproval) || baselineApproval)) {
      const verdict = await this.awaitApproval(
        taskCtx,
        request,
        baselineApproval ? `baseline_approval:${request.key}` : `grant_approval:${request.key}`,
      );
      if (!verdict.allow && recordDenial) return this.deny(taskCtx, verdict.rule, request);
      return verdict;
    }
    return ALLOW;
  }

  private async deny(taskCtx: TaskCtx, rule: string, request: PolicyRequest): Promise<Verdict> {
    await publish(this.db, {
      type: "policy.denied",
      sourceTaskId: taskCtx.taskId,
      sourceRunId: taskCtx.runId,
      packet: {
        runId: taskCtx.runId,
        taskId: taskCtx.taskId,
        check: request.check,
        rule,
        ...request.diagnostic,
      },
    });
    return { allow: false, rule };
  }

  private async awaitApproval(taskCtx: TaskCtx, request: PolicyRequest, rule: string): Promise<Verdict> {
    const approvalId = newId("approval");
    const expiresAt = new Date(Date.now() + this.approvalTtlMs);
    const parked = await this.db.transaction(async (trx) => {
      const [run] = await trx
        .update(runs)
        .set({ status: "awaiting_approval" })
        .where(and(eq(runs.id, taskCtx.runId), eq(runs.status, "running")))
        .returning();
      if (!run) return false;
      await trx.insert(approvals).values({
        id: approvalId,
        runId: taskCtx.runId,
        taskId: taskCtx.taskId,
        check: request.check,
        rule,
        requestJson: request.diagnostic,
        expiresAt,
      });
      await publish(trx, {
        type: "approval.requested",
        sourceTaskId: taskCtx.taskId,
        sourceRunId: taskCtx.runId,
        packet: { approvalId, runId: taskCtx.runId, taskId: taskCtx.taskId, check: request.check, rule, expiresAt: expiresAt.toISOString() },
      });
      return true;
    });
    if (!parked) return { allow: false, rule: "run_not_approvable" };

    for (;;) {
      const [row] = await this.db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
      if (!row) return { allow: false, rule: "approval_missing" };
      if (row.status !== "pending") return this.finishApprovalWait(taskCtx, row);
      if (row.expiresAt.getTime() <= Date.now()) {
        const [expired] = await this.db
          .update(approvals)
          .set({ status: "expired", decidedAt: sql`now()` })
          .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
          .returning();
        if (expired) {
          await publish(this.db, {
            type: "approval.denied",
            sourceTaskId: taskCtx.taskId,
            sourceRunId: taskCtx.runId,
            packet: { approvalId, runId: taskCtx.runId, taskId: taskCtx.taskId, reason: "expired" },
          });
          return this.finishApprovalWait(taskCtx, expired);
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.approvalPollMs));
    }
  }

  private async finishApprovalWait(taskCtx: TaskCtx, approval: ApprovalRow): Promise<Verdict> {
    if (approval.status !== "cancelled") {
      await this.db
        .update(runs)
        .set({ status: "running", heartbeatAt: sql`now()` })
        .where(and(eq(runs.id, taskCtx.runId), eq(runs.status, "awaiting_approval")));
    }
    return approval.status === "granted"
      ? ALLOW
      : { allow: false, rule: approval.status === "expired" ? "approval_expired" : `approval_${approval.status}` };
  }
}
