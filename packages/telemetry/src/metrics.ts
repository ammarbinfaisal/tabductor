import type { Meter } from "@opentelemetry/api";

/**
 * The §17.2 metrics catalogue, as code. Names are binding — renaming one breaks dashboards
 * and alerts, so they live here once and nowhere else. A call site cannot misspell one,
 * because a call site never names one: it calls `metrics.runs.record({...})`.
 *
 * Labels are typed to the bounded sets §17.2 allows. `run_id` and `event_id` are span and
 * log attributes, **never** metric labels — a metric keyed on them would multiply series
 * per run until the backend fell over. That rule is enforced by these signatures.
 *
 * Only the rows with backing code today are here. Every later subphase adds its own rows as
 * it builds the surface they measure (impl-phases §0.5 standing rule) — browser, LLM, MCP,
 * render, store, policy.
 */

export type RunStatus = "succeeded" | "failed" | "timed_out" | "cancelled";
export type FireResult = "fired" | "skipped_overlap" | "skipped_missed" | "queued";
export type ShareViewResult = "ok" | "unknown" | "revoked" | "rate_limited";
export type ShareAssetOutcome = "ok" | "denied" | "not_found";
/** `packages/assets`'s tool call sites (S5d). Not in the §17.2 catalogue as shipped — this
 * is that catalogue's first addition since the doc was written; note it there via a doc
 * change, the same courtesy the catalogue's own "rename via doc change" rule implies for a
 * new row. */
export type AssetWriteOutcome = "ok" | "denied" | "invalid" | "error";
export type AssetReadOutcome = "ok" | "not_found" | "invalid" | "error";
export type PolicyCheck = "navigation" | "action" | "network_read" | "mcp_call";
export type ResourceLimit = "max_tabs" | "max_visits" | "max_wall_ms";
/** Which side of one `Llm.complete` call a token count belongs to (§17.2 catalogue). */
export type LlmDirection = "in" | "out";
/** The secrets broker's own outcome set (§17.2, S5b) — coarser than `secret_access_log.action`
 * on purpose: the metric is the security-signals board's flat-zero row, the log is the
 * per-attempt audit trail, and a label needs far fewer values than a log column does. */
export type SecretFillOutcome = "filled" | "denied_origin" | "denied_target" | "rate_limited";
// -- S5c: MCP client (§17.2 catalogue, `mcp_calls_total`/`mcp_call_duration_seconds`) ----
/** `packages/mcp`'s own outcome set for one `callTool` attempt. `denied` never actually
 * fires under `AllowAllGate` (S7's business) but the label exists so the metric doesn't
 * need a new value the day the real evaluator lands. */
export type McpCallOutcome = "ok" | "error" | "denied" | "timeout" | "budget_exceeded";
// -----------------------------------------------------------------------------------------
// --- S5e: LaTeX renderer (§17.2 binding names, reserved by the catalogue, first call site
// here). ----------------------------------------------------------------------------------
/** `assets.render`'s own outcome set. `killed` covers both wall-clock and memory kills —
 * `renderSandboxKills` below is where the *reason* for a kill is the label, so this one stays
 * within §17.2's bounded-label-set rule. */
export type RenderOutcome = "ok" | "compile_error" | "killed" | "write_error";
/** A render the sandbox itself stopped before tectonic finished on its own — a resource-cap
 * breach, not a document defect. Distinguished from a structural block (e.g. shell-escape
 * being unconditionally absent, or `openin`/`openout` having nothing outside scratch to
 * reach) precisely because a kill is a *runtime* intervention and a structural control never
 * needs one — `docs/subphases/S5e-latex-renderer.md`'s own test-naming rule. */
export type RenderSandboxKillReason = "wall_clock" | "memory";
// -----------------------------------------------------------------------------------------
// --- S5h: Python compute -------------------------------------------------------------------
/** One Python job's terminal outcome, host side. `write_error` is the asset-store write
 * failing *after* a job succeeded — a host fault, deliberately distinct from anything the
 * program itself did. `unavailable` is pyrunner being unreachable, which is infrastructure. */
export type PyrunOutcome =
  | "ok"
  | "program_error"
  | "killed"
  | "output_cap"
  | "write_error"
  | "unavailable";
/**
 * The only runtime control that survives the S5h reshape. Single-valued today and still a
 * label rather than a bare counter, so a second control does not need a second metric.
 *
 * §17.2 names are binding, so two renames are recorded here rather than made silently: this
 * is `python-compute.md` §10's `pyrun_sandbox_kills_total` (there is no sandbox left to name
 * — the container is the isolation unit), and `pyrun_vm_boot_seconds` is dropped outright
 * (there is no VM to boot).
 */
export type PyrunKillReason = "wall_clock";
// -------------------------------------------------------------------------------------------

export type Metrics = {
  /** How long an event waited in the outbox before a dispatcher delivered it. */
  outboxDispatchLag: { record: (seconds: number) => void };
  /** Rows still pending, sampled on collection — the backlog, not the throughput. */
  observeOutboxDepth: (count: () => Promise<number>) => void;
  outboxDeadLetters: { add: () => void };
  /** A redelivery that the `(task, event)` claim refused — at-least-once working as designed. */
  eventsDedupeDropped: { add: () => void };
  /** How late a fire was against the tick it was due on. */
  schedulerFireLag: { record: (seconds: number) => void };
  schedulerFires: { add: (result: FireResult) => void };
  runs: { add: (labels: { kind: string; mode: string; status: RunStatus }) => void };
  runDuration: { record: (seconds: number, labels: { kind: string; mode: string }) => void };
  crashRecoveredRuns: { add: (count?: number) => void };
  /**
   * A request against a share link (S2d). `result="unknown"` climbing is someone guessing
   * tokens, which is why this belongs on the security-signals board rather than an
   * engagement one — the share *token* is never a label, and neither is the workflow.
   */
  shareViews: { add: (result: ShareViewResult) => void };
  /** Public asset reads (S2d reserved the name; S5d is the first real call site, at the
   * public asset route). */
  shareAssetReads: { add: (outcome: ShareAssetOutcome) => void };
  /** `assets.write`/`assets.append` (S5d). */
  assetWrites: { add: (outcome: AssetWriteOutcome) => void };
  /** `assets.read`/`assets.list` (S5d). */
  assetReads: { add: (outcome: AssetReadOutcome) => void };
  /**
   * Every verdict the gate returns (S3a). `result="deny"` on the security-signals board is
   * an agent trying to leave its allowlist, which is a thing to be told about.
   *
   * No `rule` label yet, deliberately: under `AllowAllGate` there is exactly one rule, and
   * S7 is where the label becomes worth its cardinality (§17.2).
   */
  policyVerdicts: { add: (labels: { check: PolicyCheck; result: "allow" | "deny" }) => void };
  /**
   * Per-endpoint health, sampled on collection (S3b) — the pool holds no counter of its
   * own for this, `cdp_endpoints.healthy` already is one, so the callback just reads it.
   */
  observeBrowserEndpointHealthy: (
    list: () => Promise<{ endpointId: string; healthy: boolean }[]>,
  ) => void;
  /** A connection the pool was actively using dropped out from under a lease (S3b). */
  browserDisconnects: { add: (labels: { endpointId: string }) => void };
  /** Time an `acquire` spent queued behind another run before the lease was granted (S3b),
   * recorded at grant — zero for an endpoint that was free. */
  browserQueueWait: { record: (seconds: number, labels: { endpointId: string }) => void };
  /**
   * Not in the §17.2 catalogue by name; added under its "every later subphase adds its own
   * rows" growth clause. `browser_queue_wait_seconds` alone cannot distinguish "briefly
   * queued" from "the queue is full and rejecting" — this is the backpressure signal (§15)
   * for the latter.
   */
  browserQueueRejected: { add: (labels: { endpointId: string }) => void };
  /**
   * A run aborted by `packages/browser`'s runtime caps (S3b, §8) — never the policy engine's
   * business, which is why this counter is separate from `policyVerdicts` even though both
   * fire from the same `session.ts` call sites.
   */
  resourceLimitAborts: { add: (labels: { limit: ResourceLimit }) => void };
  /**
   * S4b: every `Llm.complete` call, live or recorded (never replay — replay touches no
   * provider and spends nothing). `model` and `direction` are the only labels, per §17.2's
   * bounded-label-set rule; token counts themselves carry no prompt/completion content.
   */
  llmTokens: { add: (count: number, labels: { model: string; direction: LlmDirection }) => void };
  /**
   * Priced from the same call, via the adapter's own model→price table (packages/agent) —
   * `kind`/`mode` are the task's, constant `browser`/`ai` until S5a's discriminants land,
   * passed through rather than invented (mirrors `engine.ts`'s `recordOutcome` precedent).
   */
  llmCostUsd: { add: (usd: number, labels: { model: string; kind: string; mode: string }) => void };
  /** Every `fill` attempt the secrets broker makes, success or refusal (S5b, §16 Threat 4).
   * No `secretName` label — the bounded-label-set rule (§17.2) and the fact that a secret name
   * is exactly the kind of identifier that does not belong on a metric. */
  secretFills: { add: (labels: { outcome: SecretFillOutcome }) => void };
  // -- S5c: MCP client (§17.2 catalogue) -------------------------------------------------
  /** Every `callTool` attempt the MCP client makes (S5c, §13). `server` is the configured
   * label, never the tool's own name or arguments — the bounded-label-set rule (§17.2). */
  mcpCalls: { add: (labels: { server: string; outcome: McpCallOutcome }) => void };
  mcpCallDuration: { record: (seconds: number, labels: { server: string; outcome: McpCallOutcome }) => void };
  // -----------------------------------------------------------------------------------------
  // --- S5e: LaTeX renderer -----------------------------------------------------------------
  /** Wall-clock time of one `assets.render` call, host side (queueing + sandbox + asset
   * write) — not tectonic's own internal timing, which never leaves the container. No
   * `.tex` source, no TeX log, no rendered filename — content never becomes a label
   * (§17.2, S5e deliverable 5). */
  renderDuration: { record: (seconds: number, labels: { outcome: RenderOutcome }) => void };
  /** A render the sandbox killed rather than let finish — lands on the security-signals
   * dashboard beside the isolate (§12) and Python (S5h) kill rows it already reserves space
   * for. */
  renderSandboxKills: { add: (labels: { reason: RenderSandboxKillReason }) => void };
  // -------------------------------------------------------------------------------------------
  // --- S5h: Python compute -----------------------------------------------------------------
  /** One job, by terminal outcome. Recorded host-side in `packages/engine`'s
   * `python-executor.ts` and nowhere else — `apps/pyrunner` deliberately records nothing, the
   * same split `render_duration_seconds` follows, because recording in both would double-count
   * every job. */
  pyrunJobs: { add: (labels: { outcome: PyrunOutcome }) => void };
  /** Wall-clock time of one job, host side: resolving inputs, the HTTP hop, the program, and
   * the asset writes. No source, no filenames, no output contents — content never becomes a
   * label (§17.2). */
  pyrunDuration: { record: (seconds: number, labels: { outcome: PyrunOutcome }) => void };
  /** A job the wall clock stopped. Lands on the security-signals dashboard beside the
   * renderer's kill row. */
  pyrunKills: { add: (labels: { reason: PyrunKillReason }) => void };
  /** Total bytes a job's outputs occupied, after the caps allowed them through. */
  pyrunOutputBytes: { record: (bytes: number) => void };
  // -------------------------------------------------------------------------------------------
  // --- S5g: workflow data store (§17.2 binding names, impl-phases §0.5) ------------------
  /** One `store.query` call, wherever it started resolving (the parse gate) or finished
   * (Postgres) — `outcome="ok"` is only recorded once the query actually ran. No SQL text,
   * no row values, no table names as labels (§17.2 content rule: identifiers/durations/
   * outcomes only). */
  storeQueryDuration: { record: (seconds: number, labels: { outcome: "ok" | "error" }) => void };
  /**
   * Every parse-gate rejection (§3.5): "a series that should sit at zero... a nonzero rate is
   * either a prompting bug or an injection attempt probing the fence." `reason` is the fence's
   * own closed label set (`FenceReason`) — never the rejected SQL text itself.
   */
  storeSqlRejected: {
    add: (labels: { reason: "parse_error" | "multi_statement" | "not_select" | "locking_clause" }) => void;
  };
  // -----------------------------------------------------------------------------------------
};

export function createMetrics(meter: Meter): Metrics {
  const outboxDispatchLag = meter.createHistogram("outbox_dispatch_lag_seconds", {
    unit: "s",
    description: "Time between an event being written to the outbox and being delivered",
  });
  const outboxDeadLetters = meter.createCounter("outbox_dead_letters_total");
  const eventsDedupeDropped = meter.createCounter("events_dedupe_dropped_total");
  const schedulerFireLag = meter.createHistogram("scheduler_fire_lag_seconds", { unit: "s" });
  const schedulerFires = meter.createCounter("scheduler_fires_total");
  const runs = meter.createCounter("runs_total");
  const runDuration = meter.createHistogram("run_duration_seconds", { unit: "s" });
  const crashRecoveredRuns = meter.createCounter("crash_recovered_runs_total");
  const shareViews = meter.createCounter("share_views_total");
  const shareAssetReads = meter.createCounter("share_asset_reads_total");
  const assetWrites = meter.createCounter("asset_writes_total");
  const assetReads = meter.createCounter("asset_reads_total");
  const policyVerdicts = meter.createCounter("policy_verdicts_total");
  const browserDisconnects = meter.createCounter("browser_disconnects_total");
  const browserQueueWait = meter.createHistogram("browser_queue_wait_seconds", { unit: "s" });
  const browserQueueRejected = meter.createCounter("browser_queue_rejected_total");
  const resourceLimitAborts = meter.createCounter("resource_limit_aborts_total");
  const llmTokens = meter.createCounter("llm_tokens_total");
  const llmCostUsd = meter.createCounter("llm_cost_usd_total", { unit: "USD" });
  const secretFills = meter.createCounter("secret_fills_total");
  // -- S5c: MCP client --------------------------------------------------------------------
  const mcpCalls = meter.createCounter("mcp_calls_total");
  const mcpCallDuration = meter.createHistogram("mcp_call_duration_seconds", { unit: "s" });
  // -----------------------------------------------------------------------------------------
  // --- S5e: LaTeX renderer --------------------------------------------------------------
  const renderDuration = meter.createHistogram("render_duration_seconds", { unit: "s" });
  const renderSandboxKills = meter.createCounter("render_sandbox_kills_total");
  // -------------------------------------------------------------------------------------------
  // --- S5h: Python compute -------------------------------------------------------------------
  const pyrunJobs = meter.createCounter("pyrun_jobs_total");
  const pyrunDuration = meter.createHistogram("pyrun_duration_seconds", { unit: "s" });
  const pyrunKills = meter.createCounter("pyrun_kills_total");
  const pyrunOutputBytes = meter.createHistogram("pyrun_output_bytes", { unit: "By" });
  // -------------------------------------------------------------------------------------------
  // --- S5g: workflow data store ------------------------------------------------------------
  const storeQueryDuration = meter.createHistogram("store_query_duration_seconds", { unit: "s" });
  const storeSqlRejected = meter.createCounter("store_sql_rejected_total");
  // -----------------------------------------------------------------------------------------

  return {
    outboxDispatchLag: { record: (seconds) => outboxDispatchLag.record(seconds) },

    observeOutboxDepth(count) {
      // An observable gauge, so the backlog is read when someone is collecting rather than
      // on a timer of our own. With no exporter configured the meter is the API's no-op and
      // this callback is never invoked — which is what "inert when disabled" has to mean for
      // something that would otherwise query the database forever.
      const gauge = meter.createObservableGauge("outbox_undispatched_rows");
      gauge.addCallback(async (result) => result.observe(await count()));
    },

    outboxDeadLetters: { add: () => outboxDeadLetters.add(1) },
    eventsDedupeDropped: { add: () => eventsDedupeDropped.add(1) },
    schedulerFireLag: { record: (seconds) => schedulerFireLag.record(seconds) },
    schedulerFires: { add: (result) => schedulerFires.add(1, { result }) },
    runs: { add: (labels) => runs.add(1, { ...labels }) },
    runDuration: { record: (seconds, labels) => runDuration.record(seconds, { ...labels }) },
    crashRecoveredRuns: { add: (count = 1) => crashRecoveredRuns.add(count) },
    shareViews: { add: (result) => shareViews.add(1, { result }) },
    shareAssetReads: { add: (outcome) => shareAssetReads.add(1, { outcome }) },
    assetWrites: { add: (outcome) => assetWrites.add(1, { outcome }) },
    assetReads: { add: (outcome) => assetReads.add(1, { outcome }) },
    policyVerdicts: { add: (labels) => policyVerdicts.add(1, { ...labels }) },

    observeBrowserEndpointHealthy(list) {
      // Same "pull on collection" shape as `observeOutboxDepth`: with no exporter
      // configured the callback is never invoked, so this stays inert when disabled.
      const gauge = meter.createObservableGauge("browser_endpoint_healthy");
      gauge.addCallback(async (result) => {
        for (const { endpointId, healthy } of await list()) {
          result.observe(healthy ? 1 : 0, { endpoint_id: endpointId });
        }
      });
    },

    browserDisconnects: {
      add: ({ endpointId }) => browserDisconnects.add(1, { endpoint_id: endpointId }),
    },
    browserQueueWait: {
      record: (seconds, { endpointId }) => browserQueueWait.record(seconds, { endpoint_id: endpointId }),
    },
    browserQueueRejected: {
      add: ({ endpointId }) => browserQueueRejected.add(1, { endpoint_id: endpointId }),
    },
    resourceLimitAborts: { add: (labels) => resourceLimitAborts.add(1, { ...labels }) },
    llmTokens: { add: (count, labels) => llmTokens.add(count, { ...labels }) },
    llmCostUsd: { add: (usd, labels) => llmCostUsd.add(usd, { ...labels }) },
    secretFills: { add: (labels) => secretFills.add(1, { ...labels }) },
    // -- S5c: MCP client ------------------------------------------------------------------
    mcpCalls: { add: (labels) => mcpCalls.add(1, { ...labels }) },
    mcpCallDuration: { record: (seconds, labels) => mcpCallDuration.record(seconds, { ...labels }) },
    // ---------------------------------------------------------------------------------------
    // --- S5e: LaTeX renderer ---------------------------------------------------------------
    renderDuration: { record: (seconds, labels) => renderDuration.record(seconds, { ...labels }) },
    renderSandboxKills: { add: (labels) => renderSandboxKills.add(1, { ...labels }) },
    // -------------------------------------------------------------------------------------------
    // --- S5h: Python compute -------------------------------------------------------------------
    pyrunJobs: { add: (labels) => pyrunJobs.add(1, { ...labels }) },
    pyrunDuration: { record: (seconds, labels) => pyrunDuration.record(seconds, { ...labels }) },
    pyrunKills: { add: (labels) => pyrunKills.add(1, { ...labels }) },
    pyrunOutputBytes: { record: (bytes) => pyrunOutputBytes.record(bytes) },
    // -------------------------------------------------------------------------------------------
    // --- S5g: workflow data store ------------------------------------------------------------
    storeQueryDuration: { record: (seconds, labels) => storeQueryDuration.record(seconds, { ...labels }) },
    storeSqlRejected: { add: (labels) => storeSqlRejected.add(1, { ...labels }) },
    // -----------------------------------------------------------------------------------------
  };
}
