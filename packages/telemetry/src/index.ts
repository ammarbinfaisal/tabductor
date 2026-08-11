/**
 * The library surface: types, the metric registry, propagation helpers, pino — and **no
 * OpenTelemetry SDK**. `initTelemetry` deliberately lives behind a separate entry point
 * (`@tabductor/telemetry/init`) that only composition roots import.
 *
 * That split is §17.2 rule 1 made structural rather than aspirational. It is also what keeps
 * the SDK's module graph — which does not survive being bundled — out of `apps/web`'s pages,
 * which reach this package transitively through `@tabductor/engine`.
 */
export type { Telemetry, TelemetryConfig } from "./init.js";
export {
  createMetrics,
  type FireResult,
  type Metrics,
  type PolicyCheck,
  type ResourceLimit,
  type RunStatus,
  type ShareAssetOutcome,
  type ShareViewResult,
} from "./metrics.js";
export { createPinoLogger } from "./logger.js";
export {
  contextFromTraceparent,
  currentTraceparent,
  inSpan,
  startConsumerSpan,
} from "./propagation.js";
/**
 * The API surface — never the SDK — re-exported so packages can carry spans and context
 * without taking an OpenTelemetry dependency of their own. It is inert until a composition
 * root calls `initTelemetry` with an endpoint.
 */
export type { Context, Meter, Span, Tracer } from "@opentelemetry/api";
export { context, trace } from "@opentelemetry/api";
