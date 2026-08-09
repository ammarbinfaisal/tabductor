# SOb — Platform telemetry: OTel + pino + bus propagation + engine instrumentation

You are implementing subphase SOb. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — §0.5 (build placement, standing rules) and the repository layout
   (`/packages/telemetry`).
3. `docs/techical_plan.md` — §17.2 in full: wiring rules, content/cardinality rules, the
   **binding metrics catalogue**, dashboards. §17.2 is the spec; this file is its cut for
   what exists today.
4. `docs/subphases/ROADMAP.md` — platform-observability stack bullet.

Existing code to reuse (read first): `packages/bus` (outbox publisher + dispatcher — where
spans and most counters attach), `packages/engine` (run state machine, scheduler, retry,
crash-recovery watchdog), `packages/db` (drizzle migration workflow). Composition roots
today: `apps/web` (S2c); `apps/engine` when it appears. The test harness NEVER initializes
the SDK.

## Scope
Instrument what exists (bus, engine, scheduler). Browser/LLM/MCP/render/store metrics are
added by the subphases that build those surfaces (impl §0.5 standing rule) — do NOT stub
them here. Telemetry is operator-facing only: no product feature may read it.

## Deliverables

1. **`packages/telemetry`**
   - `initTelemetry(config) → Telemetry` where `Telemetry = { tracer, meter, logger, shutdown() }`.
     Called ONLY by composition roots; every package receives what it needs by constructor
     injection, exactly like `PolicyGate`. Library packages must not import the OTel SDK.
   - **Strict no-op mode:** when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, providers are no-op
     and pino writes pretty console output — zero sockets, zero exporters, zero background
     timers. This is the CI and docker-less-dev mode; the app never assumes a collector.
   - **pino logger factory:** JSON output, `child({run_id, task_id, trace_id})` bindings,
     OTLP log bridge active only when exporting. ESLint rule (root flat config) banning
     `console.log/info/warn/error` in `packages/*` and `apps/*` (testkit and test files exempt).
   - **Metric registry:** typed helpers for the §17.2 catalogue names — misspelling a binding
     name must be a compile error, not a runtime surprise. Labels restricted to the bounded
     sets in §17.2; `run_id`/`event_id` are span/log attributes, NEVER metric labels.
2. **Bus propagation** (one additive drizzle migration + `packages/bus` changes):
   - `traceparent text` column on `outbox` and `events`. Publish captures the active span
     context (W3C format) into the row; emit happens inside a producer span.
   - Dispatch starts a consumer span as the producer's **child**; redeliveries
     (`attempts > 0`) and retried runs start fresh spans carrying a **span link** to the
     original producer context instead of a parent (§17.2 rule 3). Null `traceparent`
     (pre-migration rows, tests) → root span, no error.
3. **Engine/scheduler instrumentation** — exactly these catalogue rows, exact names:
   `outbox_dispatch_lag_seconds`, `outbox_undispatched_rows` (gauge, observed on collection),
   `outbox_dead_letters_total`, `events_dedupe_dropped_total`, `scheduler_fire_lag_seconds`,
   `scheduler_fires_total{result}`, `runs_total{kind,mode,status}`,
   `run_duration_seconds{kind,mode}`, `crash_recovered_runs_total`. (`kind` is constant
   `browser` until S5a adds the column — pass it through, don't invent state.)
4. **Dashboards + runbook:** `infra/grafana/dashboards/engine-health.json` and
   `security-signals.json` (provisioned JSON, versioned like code; security board starts
   with dead letters + dedupe drops and gains series in later subphases), plus
   `infra/otel-lgtm/README.md` — how to run the `grafana/otel-lgtm` all-in-one container
   where Docker exists and point the app at it with env vars.
5. **Tests.** Telemetry is NOT an assertion surface — no system test may assert on spans or
   metric values; traces/events remain the ground truth. Required: one smoke test proving
   disabled-mode init performs no I/O (no sockets opened, no timers/handles left — the suite
   must exit cleanly without `shutdown()` hacks). All prior suites stay green untouched.

## Style constraints (binding)
- **Content rules are law (§17.2):** telemetry carries identifiers, durations, sizes, and
  outcomes — never page content, packet bodies, prompts, SQL text, secrets, or CDP URLs;
  navigation appears at domain granularity only. Violations are the same defect class as a
  secret in a trace.
- No metrics/logging façade beyond the one `Telemetry` bundle; no wrapper per package.
- New deps: `@opentelemetry/api`, `@opentelemetry/sdk-node`, OTLP exporters (trace/metric/log),
  `pino` (+ `pino-pretty` dev-only). Justify anything else.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests stay green; run twice. The suite must not hang on exit (leaked telemetry
handles are the likely cause if it does).

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Do NOT git commit.
