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
  };
}
