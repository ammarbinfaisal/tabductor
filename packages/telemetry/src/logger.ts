import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LogLevel, Logger } from "@tabductor/core";
import pino, { type Logger as PinoLogger } from "pino";

/**
 * The pino implementation of core's `Logger` (§17.2): structured JSON, child loggers bound
 * with `run_id`/`task_id`/`trace_id`, and — when an OTLP endpoint is configured — bridged to
 * Loki, with the active span's trace id attached so a log line and the span that produced it
 * find each other.
 *
 * The bridge is **explicit**, not `@opentelemetry/instrumentation-pino`. That instrumentation
 * patches pino through `require`, which never fires in this codebase: everything is ESM, and
 * making the hook work would mean an `import-in-the-middle` loader on every entry point. Ten
 * lines that always run beat a loader flag that silently does nothing — and this is a
 * codebase that injects its dependencies rather than monkey-patching them anyway.
 *
 * `logs.getLogger` is a no-op until the SDK registers a provider, so the disabled mode pays
 * for this in allocations and nothing else.
 *
 * Content rules apply to every call site: identifiers, durations, sizes and outcomes, never
 * page content, packets, prompts, SQL text, secrets or CDP URLs (§17.2). A log line with a
 * tweet body in it is the same class of defect as a secret in a trace.
 */
export function createPinoLogger(opts: { name?: string; level?: string; pretty?: boolean } = {}): Logger {
  // Pretty printing runs pino-pretty in a **worker thread**, which is background work — so
  // it is opted into rather than defaulted on. A human at a terminal gets it; CI, the test
  // suite and containers get JSON and no worker, which is what §17.2's "inert when
  // disabled" has to mean if the disabled-mode smoke test is to be worth anything.
  const pretty = opts.pretty ?? (process.stdout.isTTY === true && process.env.LOG_PRETTY !== "0");
  const base = pino({
    ...(opts.name ? { name: opts.name } : {}),
    level: opts.level ?? process.env.LOG_LEVEL ?? "info",
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } } }
      : {}),
  });
  return wrap(base, opts.name ?? "app", {});
}

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

function attributesOf(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    out[key] =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : JSON.stringify(value);
  }
  return out;
}

function wrap(logger: PinoLogger, name: string, bindings: Record<string, unknown>): Logger {
  const otel = logs.getLogger(name);

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    logger[level](fields ?? {}, msg);
    otel.emit({
      severityNumber: SEVERITY[level],
      severityText: level,
      body: msg,
      // Bindings ride along as attributes so a child logger's `run_id` is queryable in Loki
      // rather than only visible in the JSON line. Values are flattened to primitives the
      // log protocol accepts; a caller passing something structured gets it stringified
      // rather than dropped.
      attributes: attributesOf({ ...bindings, ...fields }),
    });
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (extra) => wrap(logger.child(extra), name, { ...bindings, ...extra }),
  };
}
