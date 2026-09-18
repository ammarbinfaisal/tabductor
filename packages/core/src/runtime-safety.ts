import { loadConfig } from "./config.js";

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


export const DEFAULT_TOKEN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]+/gi,
];

export function maskText(value: string, patterns: readonly RegExp[]): string {
  let masked = value;
  for (const pattern of patterns) masked = masked.replace(pattern, "[REDACTED]");
  return masked;
}
