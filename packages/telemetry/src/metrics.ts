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
 * it builds the surface they measure — browser, LLM, store, policy.
 */

export type RunStatus = "succeeded" | "failed" | "timed_out" | "cancelled";
export type FireResult = "fired" | "skipped_overlap" | "skipped_missed" | "queued" | "blocked_prerequisite";
export type ShareViewResult = "ok" | "unknown" | "revoked" | "rate_limited";
export type PolicyCheck = "navigation" | "action" | "network_read";
export type ResourceLimit = "max_tabs" | "max_visits" | "max_wall_ms";
/** Which side of one `Llm.complete` call a token count belongs to (§17.2 catalogue). */
export type LlmDirection = "in" | "out";
/** The secrets broker's own outcome set (§17.2, S5b) — coarser than `secret_access_log.action`
 * on purpose: the metric is the security-signals board's flat-zero row, the log is the
 * per-attempt audit trail, and a label needs far fewer values than a log column does. */
export type SecretFillOutcome = "filled" | "denied_origin" | "denied_grant" | "denied_target" | "rate_limited";
// --- S6a: static runtime (added under §17.2's "every later subphase adds its own rows"
// growth clause, same clause S3b's browserQueueRejected and S5g/S5h's rows came in under) ---
/** How a compiled script's run ended. `deopt` is not a failure — it is the script handing
 * back to the agent, which S6c turns into a mid-run handoff. */
export type StaticRtOutcome = "completed" | "deopt" | "killed" | "error";
/** A run the isolate itself stopped; should be near zero outside hostile-corpus runs. */
export type StaticRtKillReason = "wall_clock" | "memory";
// -----------------------------------------------------------------------------------------
// --- S6b/S6e: trace compiler ----------------------------------------------------------------
/** Where a compile stopped. Every value but `ok` is a refusal that wrote no row, and the
 * distinction is the point: `evidence` means the trace does not say enough to compile from,
 * `plan` means the model's interpretation was not grounded in it, and `lint`/`validation` mean
 * the model produced code the gates caught. */
export type CompileOutcome = "ok" | "kind" | "evidence" | "llm" | "plan" | "lint" | "validation";
/** §11's deopt trigger classes. `guard_failure` is the in-script one; the rest are the
 * executor's own detections. */
export type DeoptTrigger =
  | "runtime_incompatible"
  | "guard_failure"
  | "missing_element"
  | "unexpected_dialog"
  | "unexpected_url"
  | "zero_extraction"
  | "step_timeout";
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
  // --- S6a: static runtime -------------------------------------------------------------------
  /** Wall-clock time of one `runCompiledScript` call. Instrumented at the primitive because
   * S6b's dry-run and S6c's real runs both go through it, and neither should have to add it. */
  staticRtRunDuration: { record: (seconds: number, labels: { outcome: StaticRtOutcome }) => void };
  staticRtKills: { add: (labels: { reason: StaticRtKillReason }) => void };
  /** One rejected script, by the rule that rejected it — a bounded label set, the same
   * naming precedent `store_sql_rejected_total` set. No source text ever becomes a label. */
  scriptLintRejected: { add: (labels: { rule: string }) => void };
  // -------------------------------------------------------------------------------------------
  // --- S6b: trace compiler -------------------------------------------------------------------
  /** `compile_runs_total`, reserved by §17.2's catalogue; this is its first call site. */
  compileRuns: { add: (labels: { outcome: CompileOutcome }) => void };
  compileDuration: { record: (seconds: number, labels: { outcome: CompileOutcome }) => void };
  // -------------------------------------------------------------------------------------------
  // --- S6c: compiled executor (§17.2 binding names) ------------------------------------------
  /** One deopt, by what triggered it. `llm_cost_usd_total{mode}` splits ai from compiled, so
   * these two together are what make the cost curve readable from stored data. */
  deopts: { add: (labels: { trigger: DeoptTrigger }) => void };
  promotions: { add: () => void };
  demotions: { add: () => void };
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
  const policyVerdicts = meter.createCounter("policy_verdicts_total");
  const browserDisconnects = meter.createCounter("browser_disconnects_total");
  const browserQueueWait = meter.createHistogram("browser_queue_wait_seconds", { unit: "s" });
  const browserQueueRejected = meter.createCounter("browser_queue_rejected_total");
  const resourceLimitAborts = meter.createCounter("resource_limit_aborts_total");
  const llmTokens = meter.createCounter("llm_tokens_total");
  const llmCostUsd = meter.createCounter("llm_cost_usd_total", { unit: "USD" });
  const secretFills = meter.createCounter("secret_fills_total");
  // --- S6a: static runtime -------------------------------------------------------------------
  const staticRtRunDuration = meter.createHistogram("static_rt_run_duration_seconds", { unit: "s" });
  const staticRtKills = meter.createCounter("static_rt_kills_total");
  const scriptLintRejected = meter.createCounter("script_lint_rejected_total");
  // -------------------------------------------------------------------------------------------
  // --- S6b: trace compiler -------------------------------------------------------------------
  const compileRuns = meter.createCounter("compile_runs_total");
  const compileDuration = meter.createHistogram("compile_duration_seconds", { unit: "s" });
  // -------------------------------------------------------------------------------------------
  // --- S6c: compiled executor ----------------------------------------------------------------
  const deopts = meter.createCounter("deopts_total");
  const promotions = meter.createCounter("promotions_total");
  const demotions = meter.createCounter("demotions_total");
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
    // --- S6a: static runtime -------------------------------------------------------------------
    staticRtRunDuration: { record: (seconds, labels) => staticRtRunDuration.record(seconds, { ...labels }) },
    staticRtKills: { add: (labels) => staticRtKills.add(1, { ...labels }) },
    scriptLintRejected: { add: (labels) => scriptLintRejected.add(1, { ...labels }) },
    // -------------------------------------------------------------------------------------------
    // --- S6b: trace compiler -------------------------------------------------------------------
    compileRuns: { add: (labels) => compileRuns.add(1, { ...labels }) },
    compileDuration: { record: (seconds, labels) => compileDuration.record(seconds, { ...labels }) },
    // -------------------------------------------------------------------------------------------
    // --- S6c: compiled executor ----------------------------------------------------------------
    deopts: { add: (labels) => deopts.add(1, { ...labels }) },
    promotions: { add: () => promotions.add(1) },
    demotions: { add: () => demotions.add(1) },
    // -------------------------------------------------------------------------------------------
    // --- S5g: workflow data store ------------------------------------------------------------
    storeQueryDuration: { record: (seconds, labels) => storeQueryDuration.record(seconds, { ...labels }) },
    storeSqlRejected: { add: (labels) => storeSqlRejected.add(1, { ...labels }) },
    // -----------------------------------------------------------------------------------------
  };
}
