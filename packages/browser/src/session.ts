import { AppError } from "@tabductor/core";
import type { PolicyGate, TaskCtx } from "@tabductor/policy";
import type { Metrics } from "@tabductor/telemetry";
import type {
  Anchor,
  BrowserConn,
  ExtractSpec,
  NavigationRequest,
  NetworkBody,
  NetworkHooks,
  NetworkRecord,
  Page,
} from "./driver.js";
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
export type RunSession = {
  page: Page;
  network: NetworkApi;
  /** A second guarded+traced page on the same connection (§8 `max_tabs`). */
  openTab: () => Promise<Page>;
  /**
   * Resolves an anchor (`e1`, `e2`, …) from the most recent `perceive()` call on any page in
   * this session back to the locator `Page` methods accept — S4b's loop calls this once per
   * tool call rather than holding a selector itself, and the resolved string is what lands in
   * the action's trace entry (S4a §8: "the trace records the resolved locator"). `undefined`
   * for an anchor that was never perceived, or one from a snapshot since superseded.
   */
  resolveAnchor: (anchor: Anchor) => string | undefined;
  close: () => Promise<void>;
};

/** §9 step 1's shape, with the session-assigned ordinal that makes it addressable. */
export type NetworkListRecord = NetworkRecord & { index: number };

export type NetworkListResult = { records: NetworkListRecord[]; total: number };

export type NetworkApi = {
  /**
   * Filtered by substring match on `url` — not glob — because a substring check is the one
   * predicate every future caller (LLM tool, compiler-generated `ctx.network.list`) can build
   * a pattern for without learning a syntax, and §9 only asks for *some* filter, not a
   * specific one.
   */
  list: (opts?: { urlPattern?: string; limit?: number }) => Promise<NetworkListResult>;
  body: (index: number) => Promise<Buffer>;
};

export type ResourceLimits = {
  maxTabs?: number;
  maxVisits?: number;
  maxWallMs?: number;
};

export type SessionDeps = {
  conn: BrowserConn;
  gate: PolicyGate;
  taskCtx: TaskCtx;
  trace: TraceRecorder;
  /** Injected, exactly like `PolicyGate` (§17.2 rule 1). Absent means uninstrumented, not broken. */
  metrics?: Metrics;
  /**
   * `limits_json.browser` (§8), passed through as plain options — wiring these from the task
   * row is S3b's next wave, not this one. Absent field = unlimited, matching every other
   * optional cap in this codebase.
   */
  limits?: ResourceLimits;
};

/** §9 step 2 caps a batch; the design doc leaves the exact number open. One page's worth of
 * requests is generous enough that a normal session never has to reach for `urlPattern` to
 * see everything it cares about, and small enough that a chatty page still truncates. */
const DEFAULT_NETWORK_LIST_LIMIT = 50;

export async function openRunSession(deps: SessionDeps): Promise<RunSession> {
  const { conn, gate, taskCtx, trace, metrics, limits } = deps;
  const openedAt = Date.now();

  // ---- resource limits (§8): runtime-enforced, checked before policy. A run that has
  // already spent its budget gets nothing from learning whether the action it can't afford
  // would otherwise have been allowed, and these are cost/correctness controls rather than
  // permissions (impl-phases §0 carve-out 2), so they are not `PolicyGate`'s business. ----
  let visitCount = 0;
  let tabCount = 0;

  const limitBreach = async (
    action: string,
    limit: "max_visits" | "max_tabs" | "max_wall_ms",
    detail: Record<string, unknown>,
  ): Promise<never> => {
    metrics?.resourceLimitAborts.add({ limit });
    // Kind `action`, not `policy_denied`: a breach is not a `PolicyGate` verdict, and giving
    // it the policy kind would blur a distinction the trace exists to keep — every
    // `policy_denied` row is a gate decision and nothing else's. The `limit` field is what a
    // reader (or the compiler) greps for; `action` says what was attempted when it broke.
    await trace.record("action", {
      action,
      ...detail,
      ok: false,
      error: `resource limit exceeded: ${limit}`,
      limit,
    });
    throw new AppError("resource_limit_exceeded", `${action} exceeded ${limit}`, {
      details: { limit },
    });
  };

  const wallClockExceeded = (): boolean =>
    limits?.maxWallMs !== undefined && Date.now() - openedAt > limits.maxWallMs;

  // ---- perception (S4a §8): the most recent snapshot's anchor→locator map. Overwritten by
  // every `perceive()` call, on whichever page it was taken on — an anchor answers to "the
  // last thing the agent looked at", the same one-snapshot-at-a-time model the agent loop
  // itself uses (perceive, then act on what it just saw). ----
  let anchorMap = new Map<Anchor, string>();

  // ---- network observation (§9 step 1): one shared store for every page this session opens
  // (the initial page, any `openTab()` pages, and popups either spawns), so indices stay
  // dense and continuing across all of them rather than resetting per tab. ----
  const networkRecords: NetworkListRecord[] = [];
  const bodyFetchers = new Map<number, () => Promise<NetworkBody>>();
  /** Connects a driver-level record (identity, no index) to the slot this session gave it. */
  const indexOf = new WeakMap<NetworkRecord, number>();

  const networkHooks: NetworkHooks = {
    onStart(record) {
      const index = networkRecords.length;
      indexOf.set(record, index);
      networkRecords.push({ ...record, index });
      // No trace write yet — a record with `status: null` is exactly the thing §9 step 2
      // wants `network.list()` to be able to show, but the trace is append-only and this run
      // gets one row per request, written once there is something worth more than a request
      // line to persist.
    },
    async onSettled(record, body) {
      const index = indexOf.get(record);
      if (index === undefined) return; // Cannot happen — `onStart` always precedes `onSettled`.
      const entry = networkRecords[index]!;
      entry.status = record.status;
      entry.timings = record.timings;
      bodyFetchers.set(index, body);
      await trace.record("network", {
        index,
        method: entry.method,
        url: entry.url,
        resourceType: entry.resourceType,
        status: entry.status,
        timings: entry.timings,
      });
    },
  };

  const networkList = async (
    opts: { urlPattern?: string; limit?: number } = {},
  ): Promise<NetworkListResult> => {
    const limit = opts.limit ?? DEFAULT_NETWORK_LIST_LIMIT;
    const matched = opts.urlPattern
      ? networkRecords.filter((r) => r.url.includes(opts.urlPattern!))
      : networkRecords;
    const records = matched.slice(0, limit);
    // Ungated — listing summaries is §9 step 2's cheap, always-available half; only
    // `network.body` crosses into the gated read (§9 step 3). Still an action on the record,
    // with the filter and the count it returned — never the URLs themselves, matching how
    // `queryAll` records a count rather than the content it extracted.
    await trace.record("action", {
      action: "network.list",
      urlPattern: opts.urlPattern ?? null,
      limit,
      count: records.length,
      total: matched.length,
      ok: true,
    });
    return { records, total: matched.length };
  };

  const networkBody = async (index: number): Promise<Buffer> => {
    const record = networkRecords[index];
    if (!record) {
      throw new AppError("network_index_invalid", `no network record at index ${index}`, {
        details: { index },
      });
    }

    const verdict = await gate.checkNetworkRead(taskCtx, { index, url: record.url }, { body: true });
    metrics?.policyVerdicts.add({ check: "network_read", result: verdict.allow ? "allow" : "deny" });
    if (!verdict.allow) {
      // Mirrors `onNavigationRequest`'s denial shape: a denied read is a security signal, not
      // run exhaust, so it is unaffected by the `network` storage opt-out (§14).
      await trace.record("policy_denied", {
        check: "network_read",
        index,
        url: record.url,
        rule: verdict.rule,
      });
      throw new AppError("action_denied", `network.body denied by ${verdict.rule}`, {
        details: { action: "network.body", index, rule: verdict.rule },
      });
    }

    const fetcher = bodyFetchers.get(index);
    if (!fetcher) {
      throw new AppError("network_body_unavailable", `no response body for network record ${index}`, {
        details: { index },
      });
    }

    const started = Date.now();
    try {
      const { bytes, mime } = await fetcher();
      await trace.record(
        "action",
        {
          action: "network.body",
          index,
          url: record.url,
          size: bytes.byteLength,
          ok: true,
          duration_ms: Date.now() - started,
        },
        // Body bytes ride the `network` storage category, same as the observation records
        // themselves — turning that flag off means neither exists, which is the one setting
        // a user needs to remember to keep response bodies out of storage entirely.
        { kind: "network", bytes, mime },
      );
      return bytes;
    } catch (err) {
      await trace.record("action", {
        action: "network.body",
        index,
        url: record.url,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - started,
      });
      throw err;
    }
  };

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

  /**
   * One wrapper for every action: limit check, then verdict, then the call, then the entry —
   * including on failure, because a run that failed halfway is precisely the run someone
   * reads the trace of. `detail` carries the *resolved* selector, which is what the Phase 6
   * checker matches traces on.
   */
  const act = async <T>(
    action: string,
    detail: Record<string, unknown>,
    fn: () => Promise<T>,
    onResult?: { detail?: (result: T) => Record<string, unknown>; blob?: (result: T) => BlobInput },
  ): Promise<T> => {
    if (wallClockExceeded()) return limitBreach(action, "max_wall_ms", detail);

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

  /** Wraps one raw driver page — the initial page and every `openTab()` page share this. */
  const makePage = (raw: Page): Page => ({
    async goto(url) {
      visitCount++;
      if (limits?.maxVisits !== undefined && visitCount > limits.maxVisits) {
        return limitBreach("goto", "max_visits", { url });
      }
      return act("goto", { url }, () => raw.goto(url));
    },
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
    perceive: (opts) =>
      act(
        "perceive",
        { maxChars: opts?.maxChars },
        () => raw.perceive(opts),
        {
          // Counts only, never the elements or the text themselves — the same rule
          // `queryAll` follows above, for the same reason (§14 opt-in page content).
          detail: (result) => ({ elementCount: result.elements.length, textChars: result.text.length }),
        },
      ).then((result) => {
        anchorMap = new Map(result.elements.map((e) => [e.anchor, e.locator]));
        return result;
      }),

    screenshot: () =>
      act("screenshot", {}, () => raw.screenshot(), {
        blob: (bytes) => ({ kind: "screenshots", bytes, mime: "image/png" }),
      }),
    title: () => raw.title(),
    url: () => raw.url(),
    close: () => raw.close(),
  });

  /** Every page this session has opened — closed together, so nothing outlives the run. */
  const openPages: Page[] = [];

  const openPage = async (): Promise<Page> => {
    const raw = await conn.createPage({ onNavigationRequest, network: networkHooks });
    openPages.push(raw);
    return makePage(raw);
  };

  const page = await openPage();

  const openTab = async (): Promise<Page> => {
    tabCount++;
    if (limits?.maxTabs !== undefined && tabCount > limits.maxTabs) {
      return limitBreach("openTab", "max_tabs", {});
    }
    return openPage();
  };

  return {
    page,
    network: { list: networkList, body: networkBody },
    openTab,
    resolveAnchor: (anchor) => anchorMap.get(anchor),
    async close() {
      await Promise.all(openPages.map((p) => p.close().catch(() => undefined)));
      await trace.close();
    },
  };
}
