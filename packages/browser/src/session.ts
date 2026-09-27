import { withAutomationControl } from "./control.js";
import { proxyMember } from "./playwright-contract.js";
import { randomBytes } from "node:crypto";
import { AppError, SCRIPT_RUNTIME_VERSION } from "@tabductor/core";
import type { Metrics } from "@tabductor/telemetry";
import type {
  Anchor,
  AnchoredElement,
  Perception,
  BrowserConn,
  DialogHook,
  ExtractSpec,
  NavigationRequest,
  NetworkBody,
  NetworkHeaders,
  NetworkHooks,
  NetworkParts,
  NetworkRecord,
  Page,
} from "./driver.js";
import type { BlobInput, TraceRecorder } from "./trace.js";

/**
 * Joins a raw driver page with run limits and trace recording. Executors receive this
 * session so every browser action is recorded consistently.
 *
 * The connection is a parameter, not something this opens: S3b's endpoint pool owns
 * connections and their leases, and a session that connected for itself would be a second
 * place that has to know about pooling.
 */
export type RunSession = {
  page: Page;
  network: NetworkApi;
  /**
   * Whether any page in this session has put up a JS dialog since it was opened (S6a).
   * Latching rather than since-last-check on purpose: once a modal has interrupted the run,
   * a later "no dialog" answer would be true of the moment and misleading about the run, and
   * `ctx.guard.noDialog()` exists to let a compiled script refuse exactly that situation.
   */
  dialogSeen: () => boolean;
  /** A second traced page on the same connection (§8 `max_tabs`). */
  openTab: () => Promise<Page>;
  /**
   * Resolves a snapshot-qualified anchor from the most recent `perceive()` call on any page in
   * this session back to the locator `Page` methods accept — S4b's loop calls this once per
   * tool call rather than holding a selector itself, and the resolved string is what lands in
   * the action's trace entry (S4a §8: "the trace records the resolved locator"). `undefined`
   * for an anchor that was never perceived, or one from a snapshot since superseded.
   */
  resolveAnchor: (anchor: Anchor) => string | undefined;
  /** Semantic identity for recovery only; actions still resolve the exact observed node. */
  describeAnchor?: (anchor: Anchor) => string | undefined;
  anchorInfo?: (anchor: Anchor) => AnchoredElement | undefined;
  lastPerception?: () => Perception | undefined;
  remainingWallMs?: () => number;
  dispatchState?: () => { sequence: number; status: "executed" | "failed" | "uncertain" };
  snapshotId?: () => string | undefined;
  close: () => Promise<void>;
};

/** §9 step 1's shape, with the session-assigned ordinal that makes it addressable. */
export type NetworkListRecord = NetworkRecord & { index: number };

export type NetworkListResult = { records: NetworkListRecord[]; total: number };

/** §9 step 3's four readable parts of one network record. */
export const NETWORK_READ_PARTS = [
  "request_body",
  "response_body",
  "request_headers",
  "response_headers",
] as const;
export type NetworkReadPart = (typeof NETWORK_READ_PARTS)[number];

/** One key per part actually requested — `network.read` never invents a key the caller did
 * not ask for, so a partial-parts request reads as a partial-keys result. */
export type NetworkReadResult = {
  request_body?: NetworkBody | null;
  response_body?: NetworkBody;
  request_headers?: NetworkHeaders;
  response_headers?: NetworkHeaders;
};

export type NetworkWaitOptions = {
  /** Literal URL substring, as in network.list. */
  urlPattern: string;
  method?: string;
  status?: number;
  /** Exclusive session request index; defaults to the last explicit navigation boundary. */
  afterIndex?: number;
  timeout?: number;
};

export type NetworkApi = {
  /**
   * Filtered by substring match on `url` — not glob — because a substring check is the one
   * predicate every future caller (LLM tool, compiler-generated `ctx.network.list`) can build
   * a pattern for without learning a syntax, and §9 only asks for *some* filter, not a
   * specific one.
   */
  list: (opts?: { urlPattern?: string; limit?: number }) => Promise<NetworkListResult>;
  waitForResponse: (opts: NetworkWaitOptions) => Promise<NetworkListRecord>;
  body: (index: number) => Promise<Buffer>;
  /** Read selected captured request and response parts. */
  read: (index: number, parts: NetworkReadPart[]) => Promise<NetworkReadResult>;
};

export type ResourceLimits = {
  maxTabs?: number;
  maxVisits?: number;
  maxWallMs?: number;
};

export type SessionDeps = {
  conn: BrowserConn;
  trace: TraceRecorder;
  /** Optional telemetry; absence does not affect browser actions. */
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
  const { conn, trace, metrics, limits } = deps;
  const openedAt = Date.now();
  const browserVersion = await withAutomationControl(conn, () => conn.version());
  await trace.record("runtime", { browserVersion, runtimeVersion: SCRIPT_RUNTIME_VERSION });

  // ---- Resource limits (§8) bound the cost and duration of a run. ----
  let visitCount = 0;
  let tabCount = 0;

  const limitBreach = async (
    action: string,
    limit: "max_visits" | "max_tabs" | "max_wall_ms",
    detail: Record<string, unknown>,
  ): Promise<never> => {
    metrics?.resourceLimitAborts.add({ limit });
    // The limit and attempted action identify the failure in the trace.
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
  let anchorDetails = new Map<Anchor, AnchoredElement>();
  let latestPerception: Perception | undefined;
  let dispatchSequence = 0;
  let dispatchStatus: "executed" | "failed" | "uncertain" = "uncertain";
  let snapshotSequence = 0;
  let currentSnapshotId: string | undefined;
  const snapshotNamespace = randomBytes(4).toString("hex");
  let evidenceLocators = new Map<string, string>();

  // ---- network observation (§9 step 1): one shared store for every page this session opens
  // (the initial page, any `openTab()` pages, and popups either spawns), so indices stay
  // dense and continuing across all of them rather than resetting per tab. ----
  const networkRecords: NetworkListRecord[] = [];
  const partsOf = new Map<number, NetworkParts>();
  /** Connects a driver-level record (identity, no index) to the slot this session gave it. */
  const indexOf = new WeakMap<NetworkRecord, number>();
  let navigationBoundary = -1;
  let closed = false;
  const networkWaiters = new Set<() => void>();

  /**
   * Latched for the life of the session, across every page it opens (S6a). A dialog on a
   * popup is still a dialog that interrupted this run, and `ctx.guard.noDialog()` reads this
   * to decide whether the page it is driving is in the state the script was compiled for.
   */
  let dialogFired = false;
  const onDialog: DialogHook = () => {
    dialogFired = true;
  };

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
    async onSettled(record, parts) {
      const index = indexOf.get(record);
      if (index === undefined) return; // Cannot happen — `onStart` always precedes `onSettled`.
      const entry = networkRecords[index]!;
      entry.status = record.status;
      entry.timings = record.timings;
      partsOf.set(index, parts);
      await trace.record("network", {
        index,
        method: entry.method,
        url: entry.url,
        resourceType: entry.resourceType,
        status: entry.status,
        timings: entry.timings,
      });
      for (const notify of networkWaiters) notify();
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

    const parts = partsOf.get(index);
    if (!parts) {
      throw new AppError("network_body_unavailable", `no response body for network record ${index}`, {
        details: { index },
      });
    }

    const started = Date.now();
    try {
      const { bytes, mime } = await parts.responseBody();
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

  /** Read selected parts of a captured request. */
  const networkRead = async (
    index: number,
    parts: NetworkReadPart[],
  ): Promise<NetworkReadResult> => {
    const record = networkRecords[index];
    if (!record) {
      throw new AppError("network_index_invalid", `no network record at index ${index}`, {
        details: { index },
      });
    }
    const bag = partsOf.get(index);
    if (!bag) {
      throw new AppError("network_body_unavailable", `no parts available for network record ${index}`, {
        details: { index },
      });
    }

    const result: NetworkReadResult = {};
    const started = Date.now();
    try {
      for (const part of parts) {
        switch (part) {
          case "request_headers":
            result.request_headers = await bag.requestHeaders();
            break;
          case "response_headers":
            result.response_headers = await bag.responseHeaders();
            break;
          case "request_body":
            result.request_body = await bag.requestBody();
            break;
          case "response_body":
            result.response_body = await bag.responseBody();
            break;
        }
      }

      await trace.record(
        "action",
        { action: "network.read", index, url: record.url, parts, ok: true, duration_ms: Date.now() - started },
        // Response body bytes ride the `network` storage category, same as `network.body`'s —
        // headers stay inline in the action row, small enough that a blob would be overkill.
        result.response_body
          ? { kind: "network", bytes: result.response_body.bytes, mime: result.response_body.mime }
          : undefined,
      );
      return result;
    } catch (err) {
      await trace.record("action", {
        action: "network.read",
        index,
        url: record.url,
        parts,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - started,
      });
      throw err;
    }
  };

  const onNavigationRequest = async (req: NavigationRequest): Promise<boolean> => {
    await trace.record("navigation", { url: req.url, cause: req.cause });
    return true;
  };

  /**
   * One wrapper for every action: limit check, then the call, then the entry —
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

  // Longer AI waits must still fit inside the session's remaining wall-clock budget.
  const waitWithinBudget = async <T>(action: string, timeout: number | undefined, fn: (ms: number) => Promise<T>): Promise<T> => {
    const requested = timeout ?? 15_000;
    if (!Number.isFinite(requested) || requested <= 0 || requested > 120_000) {
      throw new Error("wait timeout must be between 1 and 120000ms");
    }
    const remaining = limits?.maxWallMs === undefined ? Infinity : limits.maxWallMs - (Date.now() - openedAt);
    if (remaining <= 0) return limitBreach(action, "max_wall_ms", {});
    try {
      const result = await fn(Math.min(requested, remaining));
      if (wallClockExceeded()) return limitBreach(action, "max_wall_ms", {});
      return result;
    } catch (err) {
      if (remaining <= requested && Date.now() - openedAt >= (limits?.maxWallMs ?? Infinity)) {
        return limitBreach(action, "max_wall_ms", {});
      }
      throw err;
    }
  };

  const networkWait = (opts: NetworkWaitOptions): Promise<NetworkListRecord> => {
    const afterIndex = opts.afterIndex ?? navigationBoundary;
    return act("network.waitForResponse", { ...opts, afterIndex }, () => {
      if (!opts.urlPattern || !Number.isInteger(afterIndex) || afterIndex < -1) {
        throw new Error("waitForResponse requires a URL substring and afterIndex >= -1");
      }
      return waitWithinBudget("network.waitForResponse", opts.timeout, (timeout) =>
        new Promise<NetworkListRecord>((resolve, reject) => {
          const finish = (err?: Error, record?: NetworkListRecord): void => {
            clearTimeout(timer);
            networkWaiters.delete(check);
            if (err) reject(err);
            else resolve({ ...record!, timings: { ...record!.timings } });
          };
          const check = (): void => {
            if (closed) return finish(new Error("browser session closed while waiting for response"));
            const match = networkRecords.find((r) =>
              r.index > afterIndex && r.url.includes(opts.urlPattern) &&
              r.timings.endedAt !== null && r.status !== null &&
              (opts.method === undefined || r.method === opts.method.toUpperCase()) &&
              (opts.status === undefined || r.status === opts.status),
            );
            if (match) finish(undefined, match);
          };
          const timer = setTimeout(() => finish(new Error(`Timed out after ${timeout}ms waiting for response: ${opts.urlPattern}`)), timeout);
          networkWaiters.add(check);
          check(); // Also catches a response that finished between the action and this tool call.
        }),
      );
    }, { detail: (record) => ({ index: record.index, url: record.url, method: record.method, status: record.status, timings: record.timings }) });
  };

  /** Wraps one raw driver page — the initial page and every `openTab()` page share this. */
  const makePage = (raw: Page): Page => {
    const pageAct: typeof act = (action, detail, fn, onResult) => act(action, { ...detail,
      ...(typeof detail.selector === "string" ? { selector: evidenceLocators.get(detail.selector) ?? detail.selector } : {}), pageId: raw.id }, async () => {
        const mutation = ["goto","click","type","scroll","press","select","hover","drag","upload","download","switchTab","dialog","harness.js"].includes(action);
        if (!mutation) return fn();
        anchorMap.clear(); anchorDetails.clear(); latestPerception = undefined; currentSnapshotId = undefined;
        dispatchSequence++; dispatchStatus = "uncertain";
        try { const result = await fn(); dispatchStatus = "executed"; return result; }
        catch (error) {
          if (error instanceof AppError && error.details?.outcomeUncertain === false) dispatchStatus = "failed";
          throw error;
        }
      }, onResult);
    return {
    id: raw.id,
    ...(raw.proxy ? {proxy: async (command: import("./playwright-contract.js").ProxyCommand, opts: import("./playwright-contract.js").ProxyOptions) => {
      const call = command.call;
      const spec = call ? proxyMember(call) : undefined;
      if (command.command === "close") return raw.proxy!(command, opts);
      if (call?.member === "goto") {
        visitCount++;
        if (limits?.maxVisits !== undefined && visitCount > limits.maxVisits) return limitBreach("goto","max_visits",{});
      }
      if (call?.member === "new_page") {
        tabCount++;
        if (limits?.maxTabs !== undefined && tabCount > limits.maxTabs) return limitBreach("new_page","max_tabs",{});
      }
      if (spec?.kind === "effect") {
        anchorMap.clear(); anchorDetails.clear(); latestPerception=undefined; currentSnapshotId=undefined;
        dispatchSequence++; dispatchStatus="uncertain";
      }
      const action = call?.member === "set_input_files" ? "upload" : call?.target.class === "Download" && call.member === "save_as" ? "download" : `playwright.${call?.target.class ?? "session"}.${call?.member ?? command.command}`;
      return act(action,
        {pageId:raw.id}, async () => {
          const value = await raw.proxy!(command, opts);
          if (spec?.kind === "effect") dispatchStatus="executed";
          return value;
        });
    }} : {}),
    ...(raw.harness ? { harness: (method: string, args: Record<string, unknown>) => {
      const actions: Record<string,string> = {click:"click",click_at_xy:"click",fill:"type",type_text:"type",press_key:"press",
        scroll:"scroll",upload:"upload",download:"download",js:"harness.js",request:"harness.js",paste:"type",new_tab:"click"};
      return pageAct(actions[method] ?? "harness.read", { method, ...(typeof args.selector === "string" ? {selector:args.selector} : {}) },
        () => waitWithinBudget(`harness.${method}`, typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
          timeoutMs => raw.harness!(method, {...args,timeoutMs})));
    } } : {}),
    async goto(url, opts) {
      visitCount++;
      if (limits?.maxVisits !== undefined && visitCount > limits.maxVisits) {
        return limitBreach("goto", "max_visits", { url });
      }
      return pageAct("goto", { url, ...opts }, () => {
        navigationBoundary = networkRecords.length - 1;
        return waitWithinBudget("goto", opts?.timeout, (timeout) => raw.goto(url, { ...opts, timeout }));
      });
    },
    click: (selector) => pageAct("click", { selector }, () => raw.click(selector)),
    // The text is the *point* of not tracing it: this is the method `secrets.fill` will
    // reach for in S5b, and a trace that recorded what was typed would be the leak that
    // subphase's central test looks for. Its length is enough to debug with.
    type: (selector, text) =>
      pageAct("type", { selector, length: text.length }, () => raw.type(selector, text)),
    waitFor: (selector, opts) =>
      pageAct("waitFor", { selector, ...opts }, () =>
        waitWithinBudget("waitFor", opts?.timeout, (timeout) => raw.waitFor(selector, { ...opts, timeout }))),
    waitForLoadState: (state, opts) =>
      pageAct("waitForLoadState", { state, timeout: opts?.timeout }, () =>
        waitWithinBudget("waitForLoadState", opts?.timeout, (timeout) => raw.waitForLoadState(state, { timeout }))),
    // Untraced passthroughs, deliberately outside `pageAct()`: the secrets broker
    // writes its own access and action rows with the outcome
    // it decided, and `insertTextRaw`'s whole point is a call site that leaves nothing in the
    // trace for its `text` argument to leak into (`packages/secrets/src/broker.ts`).
    probeTarget: (selector) => raw.probeTarget(selector),
    insertTextRaw: (selector, text) => { anchorMap.clear(); currentSnapshotId = undefined; return raw.insertTextRaw(selector, text); },
    // Traced by name/mime/size only, never the bytes — the same "count or length, not
    // content" rule `type`/`queryAll`/`perceive` already follow. The bytes' own provenance
    // and integrity belong to the caller; a second copy in
    // the trace would be redundant exhaust, not evidence.
    upload: (selector, file) =>
      pageAct("upload", { selector, name: file.name, mime: file.mimeType, size: file.bytes.byteLength }, () =>
        raw.upload(selector, file),
      ),
    queryAll: (selector, fields: ExtractSpec, opts) =>
      pageAct(
        "queryAll",
        { selector, fields: Object.keys(fields), ...(opts ? { bounds: opts } : {}) },
        () => raw.queryAll(selector, fields, opts),
        // The count, never the extracted values: a trace of what was scraped is a copy of
        // the page, and §14 makes page content an opt-in category rather than a default.
        { detail: (records) => ({ count: records.length, extractionFields: fields }) },
      ),
    perceive: (opts) =>
      pageAct(
        "perceive",
        { maxChars: opts?.maxChars },
        () => raw.perceive(opts),
        {
          // Structural evidence only; page text and form values remain opt-in content.
          detail: (result) => ({ url: result.url, elementCount: result.elements.length, textChars: result.text.length,
            coverage: result.coverage, elementStructure: result.elements.slice(0, 100).map(e => ({ tag: e.tag, role: e.role, locator: ["testid","css-path"].includes(e.strategy) ? e.locator : undefined,
              strategy: e.strategy, disabled: e.disabled, inViewport: e.inViewport })) }),
        },
      ).then((result) => {
        const snapshotId = `s${snapshotNamespace}-${++snapshotSequence}`;
        currentSnapshotId = snapshotId;
        const scopeEvidence = opts?.selector ? evidenceLocators.get(opts.selector) : undefined;
        evidenceLocators = new Map(result.elements.map(e => [e.actionLocator ?? e.locator, e.locator]));
        result = { ...result, snapshotId, pageId: raw.id, scopeAnchor: result.scopeAnchor ? `${snapshotId}:${result.scopeAnchor}` : undefined, elements: result.elements.map(e => ({ ...e,
          anchor: `${snapshotId}:${e.anchor}`, parentAnchor: e.parentAnchor ? `${snapshotId}:${e.parentAnchor}` : null })) };
        anchorMap = new Map(result.elements.map((e) => [e.anchor, e.actionLocator ?? e.locator]));
        anchorDetails = new Map(result.elements.map(e => [e.anchor, e]));
        latestPerception = result;
        // A paged subtree may omit its root. Its fresh scope anchor must still resolve
        // so the next page can use the same scope without an expired anchor.
        if (result.scopeAnchor && opts?.selector) {
          anchorMap.set(result.scopeAnchor, opts.selector);
          if (scopeEvidence) evidenceLocators.set(opts.selector, scopeEvidence);
        }
        return result;
      }),

    scroll: (direction) => pageAct("scroll", { direction }, () => raw.scroll(direction)),
    screenshot: (opts) =>
      pageAct("screenshot", { selector: opts?.selector }, () => raw.screenshot(opts), {
        blob: (bytes) => ({ kind: "screenshots", bytes, mime: "image/png" }),
      }),
    ...(raw.interact ? { interact: (action: import("./driver.js").PageInteraction) =>
      pageAct(action.kind, { ...action, ...(action.kind === "dialog" ? { promptText: undefined } : {}) }, () => raw.interact!(action)) } : {}),
    ...(raw.download ? { download: (selector: string) => pageAct("download", { selector }, () => raw.download!(selector),
      { detail: file => ({ name: file.name, size: file.bytes.length }) }) } : {}),
    ...(raw.tabs ? { tabs: () => pageAct("tabs", {}, () => raw.tabs!()) } : {}),
    ...(raw.switchTab ? { switchTab: async (id: string) => {
      const selected = await pageAct("switchTab", { targetPageId: id }, () => raw.switchTab!(id));
      anchorMap.clear(); return makePage(selected);
    } } : {}),
    title: () => raw.title(),
    url: () => raw.url(),
    close: () => raw.close(),
    };
  };

  /** Every page this session has opened — closed together, so nothing outlives the run. */
  const openPages: Page[] = [];

  const openPage = async (): Promise<Page> => {
    const raw = await withAutomationControl(conn, () => conn.createPage({ onNavigationRequest, network: networkHooks, onDialog }));
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
    dialogSeen: () => dialogFired,
    network: { list: networkList, body: networkBody, read: networkRead, waitForResponse: networkWait },
    openTab,
    resolveAnchor: (anchor) => anchorMap.get(anchor),
    describeAnchor: (anchor) => { const locator = anchorMap.get(anchor); return locator ? evidenceLocators.get(locator) ?? locator : undefined; },
    anchorInfo: (anchor) => anchorDetails.get(anchor),
    lastPerception: () => latestPerception,
    remainingWallMs: () => limits?.maxWallMs === undefined ? Infinity : Math.max(0, limits.maxWallMs - (Date.now() - openedAt)),
    dispatchState: () => ({ sequence: dispatchSequence, status: dispatchStatus }),
    snapshotId: () => currentSnapshotId,
    async close() {
      closed = true;
      for (const notify of networkWaiters) notify();
      await Promise.all(openPages.map((p) => p.close().catch(() => undefined)));
      await trace.close();
    },
  };
}
