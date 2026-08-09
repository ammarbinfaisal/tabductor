# Platform observability

Operator-facing telemetry: OpenTelemetry traces, metrics and logs from `apps/engine` and
`apps/web`, exported over OTLP to Grafana LGTM (`docs/techical_plan.md` §17.2).

**It is off by default and that is the design.** With `OTEL_EXPORTER_OTLP_ENDPOINT` unset,
`initTelemetry` never constructs the SDK: no exporters, no sockets, no background timers,
and non-recording spans at every call site. That is the mode CI runs in, the mode the test
suite runs in, and the mode a docker-less dev box runs in. `tests/system/telemetry.test.ts`
asserts it, because if it ever regressed every suite in the repo would start hanging on exit
and nobody would suspect telemetry.

## Turning it on

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318 docker compose --profile telemetry up -d
open http://localhost:3001          # Grafana — 3001 so the app keeps 3000
```

Outside containers, point at the published port instead:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pnpm dev:engine
```

`grafana/otel-lgtm` is Loki (logs), Tempo (traces), Mimir (metrics) and Grafana in one
container — enough for dev and a single-node deployment. A real deployment swaps it for a
collector and the same three backends; nothing in the app changes, because the app only ever
knows an OTLP endpoint.

## Dashboards

`infra/grafana/dashboards/*.json` are provisioned as JSON and versioned like code. Import
them into Grafana (Dashboards → New → Import → upload) and pick the Prometheus/Mimir source.

| Board | What it answers |
|---|---|
| `engine-health` | Is the outbox keeping up, are runs succeeding, is the scheduler on time, did anything crash? |
| `security-signals` | The "misconfiguration or attack?" surface. Several series should sit at a flat zero — which is what makes a deviation loud. |

Two more boards from §17.2 — **cost** (tokens, spend, cost-per-run ai vs compiled) and
**browser fleet** (endpoint health, queue wait, disconnects) — arrive with the subphases that
produce their metrics (S4a/S4b and S3a/S3b). The security board grows the same way: policy
denials in S7, secret-fill denials in S5b, rejected store SQL in S5g, sandbox kills in
S5e/S6a.

Alert baseline (§17.2): any dead letter; outbox lag p95 over 30s; scheduler fire lag over one
tick; deopt-rate spike per task; any sandbox kill; crash recovery on boot; LLM spend above
budget. The panels are laid out so each of those reads off one graph.

## Rules that are not tuning advice

- **Metric names are binding.** They live once, in `packages/telemetry/src/metrics.ts`, and a
  call site never spells one — it calls `metrics.runs.add({...})`. Renaming one breaks
  dashboards and alerts, so it is a design-doc change.
- **`run_id` and `event_id` are span and log attributes, never metric labels.** Labels come
  from bounded sets (`kind`, `mode`, `status`, `result`). The typed registry enforces it.
- **Telemetry carries identifiers, durations, sizes and outcomes — never content.** No page
  content, packet bodies, prompts, MCP results, SQL text, secrets or CDP URLs; navigation
  appears at domain granularity only. Content belongs to the run trace, under the user's
  opt-outs — an operator log line containing a tweet body bypasses those opt-outs and is the
  same class of defect as a secret in a trace.
- **Telemetry is not an assertion surface.** Traces and events stay the ground truth for
  system tests. The only telemetry test is the disabled-mode smoke test above.

## Reading a workflow as one trace

The outbox row carries a W3C `traceparent`, so a whole causal chain — schedule fire →
dispatch → run → emit → next dispatch — is one distributed trace in Tempo, rooted at the fire
or the API request that started it. It is the operational mirror of `causation_id` lineage:
same shape, different audience.

Redeliveries and retries are **linked**, not parented. At-least-once delivery means one
producer span can have several consumer descendants, and drawing the second attempt as
another child would show a fan-out that never happened.
