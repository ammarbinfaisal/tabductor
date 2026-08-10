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
  /** Public asset reads. No call site until S5d resolves assets through a share. */
  shareAssetReads: { add: (outcome: ShareAssetOutcome) => void };
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
  };
}
