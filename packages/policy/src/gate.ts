import { loadConfig } from "@tabductor/core";

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
  checkMcpCall(taskCtx: TaskCtx, tool: string): Promise<Verdict>;
  redact(taskCtx: TaskCtx, payload: NetworkPayload): NetworkPayload; // no-op until Phase 7
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

  async checkMcpCall(_taskCtx: TaskCtx, _tool: string): Promise<Verdict> {
    return ALLOW;
  }

  redact(_taskCtx: TaskCtx, payload: NetworkPayload): NetworkPayload {
    return payload;
  }
}
