import { AppError } from "@tabductor/core";
import type { PolicyGate, TaskCtx } from "@tabductor/policy";
import type { Metrics } from "@tabductor/telemetry";
import type { BrowserConn, ExtractSpec, NavigationRequest, Page } from "./driver.js";
import type { BlobInput, TraceRecorder } from "./trace.js";

/**
 * Where the three halves of Phase 3 meet: a raw driver page, the policy gate, and the trace
 * recorder. Executors never see the driver directly — they get one of these, so "guarded"
 * and "traced" are properties of the only page they can reach rather than a discipline each
 * executor has to remember (impl-phases §0).
 *
 * The connection is a parameter, not something this opens: S3b's endpoint pool owns
 * connections and their leases, and a session that connected for itself would be a second
 * place that has to know about pooling.
 */
export type RunSession = { page: Page; close: () => Promise<void> };

export type SessionDeps = {
  conn: BrowserConn;
  gate: PolicyGate;
  taskCtx: TaskCtx;
  trace: TraceRecorder;
  /** Injected, exactly like `PolicyGate` (§17.2 rule 1). Absent means uninstrumented, not broken. */
  metrics?: Metrics;
};

export async function openRunSession(deps: SessionDeps): Promise<RunSession> {
  const { conn, gate, taskCtx, trace, metrics } = deps;

  const onNavigationRequest = async (req: NavigationRequest): Promise<boolean> => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      // A navigation target we cannot even parse is not one we can reason about, so it does
      // not get the benefit of the doubt.
      await trace.record("policy_denied", { check: "navigation", ...req, rule: "url_unparsable" });
      metrics?.policyVerdicts.add({ check: "navigation", result: "deny" });
      return false;
    }

    const verdict = await gate.checkNavigation(taskCtx, url, req.cause);
    metrics?.policyVerdicts.add({
      check: "navigation",
      result: verdict.allow ? "allow" : "deny",
    });
    if (verdict.allow) {
      // Recorded per navigation rather than per `goto`: a redirect chain is three entries,
      // which is exactly what someone debugging "where did it end up" needs to see.
      await trace.record("navigation", { url: req.url, cause: req.cause });
      return true;
    }
    await trace.record("policy_denied", {
      check: "navigation",
      url: req.url,
      cause: req.cause,
      rule: verdict.rule,
    });
    return false;
  };

  const raw = await conn.createPage({ onNavigationRequest });

  /**
   * One wrapper for every action: verdict first, then the call, then the entry — including
   * on failure, because a run that failed halfway is precisely the run someone reads the
   * trace of. `detail` carries the *resolved* selector, which is what the Phase 6 checker
   * matches traces on.
   */
  const act = async <T>(
    action: string,
    detail: Record<string, unknown>,
    fn: () => Promise<T>,
    onResult?: { detail?: (result: T) => Record<string, unknown>; blob?: (result: T) => BlobInput },
  ): Promise<T> => {
    const verdict = await gate.checkAction(taskCtx, { kind: action, ...detail });
    metrics?.policyVerdicts.add({ check: "action", result: verdict.allow ? "allow" : "deny" });
    if (!verdict.allow) {
      await trace.record("policy_denied", { check: "action", action, ...detail, rule: verdict.rule });
      throw new AppError("action_denied", `${action} denied by ${verdict.rule}`, {
        details: { action, rule: verdict.rule, ...detail },
      });
    }

    const started = Date.now();
    try {
      const result = await fn();
      await trace.record(
        "action",
        {
          action,
          ...detail,
          ...onResult?.detail?.(result),
          ok: true,
          duration_ms: Date.now() - started,
        },
        onResult?.blob?.(result),
      );
      return result;
    } catch (err) {
      await trace.record("action", {
        action,
        ...detail,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - started,
      });
      throw err;
    }
  };

  const page: Page = {
    goto: (url) => act("goto", { url }, () => raw.goto(url)),
    click: (selector) => act("click", { selector }, () => raw.click(selector)),
    // The text is the *point* of not tracing it: this is the method `secrets.fill` will
    // reach for in S5b, and a trace that recorded what was typed would be the leak that
    // subphase's central test looks for. Its length is enough to debug with.
    type: (selector, text) =>
      act("type", { selector, length: text.length }, () => raw.type(selector, text)),
    waitFor: (selector, opts) =>
      act("waitFor", { selector, timeout: opts?.timeout }, () => raw.waitFor(selector, opts)),
    queryAll: (selector, fields: ExtractSpec) =>
      act(
        "queryAll",
        { selector, fields: Object.keys(fields) },
        () => raw.queryAll(selector, fields),
        // The count, never the extracted values: a trace of what was scraped is a copy of
        // the page, and §14 makes page content an opt-in category rather than a default.
        { detail: (records) => ({ count: records.length }) },
      ),
    screenshot: () =>
      act("screenshot", {}, () => raw.screenshot(), {
        blob: (bytes) => ({ kind: "screenshots", bytes, mime: "image/png" }),
      }),
    title: () => raw.title(),
    url: () => raw.url(),
    close: () => raw.close(),
  };

  return {
    page,
    async close() {
      await raw.close().catch(() => undefined);
      await trace.close();
    },
  };
}
