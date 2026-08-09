import { metrics as metricsApi, trace, type Meter, type Tracer } from "@opentelemetry/api";
import type { Logger } from "@tabductor/core";
import { createPinoLogger } from "./logger.js";
import { createMetrics, type Metrics } from "./metrics.js";

/**
 * Telemetry init, called **only by composition roots** (`apps/engine`, `apps/web`, and
 * `apps/renderer` when it exists). Library packages never import this — they receive the
 * tracer, meter and logger the same way they receive a `PolicyGate` (§17.2 rule 1), which is
 * what keeps every package testable without a collector.
 *
 * **Strict no-op mode (§17.2 rule 2).** With `OTEL_EXPORTER_OTLP_ENDPOINT` unset the SDK is
 * never constructed — not started-and-disabled, not constructed. `@opentelemetry/api`
 * returns non-recording spans and no-op instruments until a provider registers, so the cost
 * is a few object allocations: zero sockets, zero exporters, zero background timers. This is
 * the CI mode, the docker-less-dev mode, and the mode the test suite runs in.
 */
export type Telemetry = {
  tracer: Tracer;
  meter: Meter;
  metrics: Metrics;
  logger: Logger;
  /** True when an OTLP endpoint was configured and the SDK is running. */
  enabled: boolean;
  shutdown: () => Promise<void>;
};

export type TelemetryConfig = {
  /** Shows up as `service.name`; one per composition root. */
  service: string;
  version?: string;
  /** Defaults to `OTEL_EXPORTER_OTLP_ENDPOINT`; empty or absent means disabled. */
  endpoint?: string;
  logLevel?: string;
  /**
   * Pretty console logs. Default: on at an interactive terminal, off everywhere else —
   * pino-pretty runs a worker thread, and §17.2's "inert when disabled" leaves no room for
   * one in CI, the test suite, or a container.
   */
  pretty?: boolean;
};

export async function initTelemetry(config: TelemetryConfig): Promise<Telemetry> {
  const endpoint = (config.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();

  if (!endpoint) {
    const tracer = trace.getTracer(config.service, config.version);
    const meter = metricsApi.getMeter(config.service, config.version);
    return {
      tracer,
      meter,
      metrics: createMetrics(meter),
      logger: createPinoLogger({
        name: config.service,
        ...(config.logLevel === undefined ? {} : { level: config.logLevel }),
        ...(config.pretty === undefined ? {} : { pretty: config.pretty }),
      }),
      enabled: false,
      shutdown: async () => {},
    };
  }

  // Imported here, not at module scope: the disabled path must not even load the SDK, and
  // loading it is what registers instrumentation hooks into `pg` and `http`.
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
  const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
  const { BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs");
  const { HttpInstrumentation } = await import("@opentelemetry/instrumentation-http");
  const { PgInstrumentation } = await import("@opentelemetry/instrumentation-pg");
  const { UndiciInstrumentation } = await import("@opentelemetry/instrumentation-undici");

  const url = (path: string): string => `${endpoint.replace(/\/$/, "")}${path}`;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": config.service,
      ...(config.version ? { "service.version": config.version } : {}),
    }),
    traceExporter: new OTLPTraceExporter({ url: url("/v1/traces") }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: url("/v1/metrics") }),
    }),
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: url("/v1/logs") }) }),
    ],
    // Selective, not `auto-instrumentations-node` (§17.2): these three are our I/O. The
    // user's page traffic is product data and never becomes platform telemetry — the
    // browser's CDP socket is deliberately not in this list.
    //
    // Caveat worth knowing before reading a trace: these patch modules through `require`,
    // and this codebase is ESM, so they only fire where something reaches CJS. Our own
    // spans and metrics are explicit and do not depend on them; pino is bridged explicitly
    // in `logger.ts` for exactly this reason. Turning them on properly needs an
    // `import-in-the-middle` loader on every entry point, which is its own decision.
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation(), new UndiciInstrumentation()],
  });
  sdk.start();

  const tracer = trace.getTracer(config.service, config.version);
  const meter = metricsApi.getMeter(config.service, config.version);
  return {
    tracer,
    meter,
    metrics: createMetrics(meter),
    logger: createPinoLogger({
      name: config.service,
      ...(config.logLevel === undefined ? {} : { level: config.logLevel }),
      // Under an exporter the log pipeline parses JSON; pretty is never right there.
      pretty: config.pretty ?? false,
    }),
    enabled: true,
    shutdown: () => sdk.shutdown(),
  };
}
