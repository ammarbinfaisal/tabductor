export type LogLevel = "debug" | "info" | "warn" | "error";

const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The logging interface every package takes by injection. `packages/telemetry` provides the
 * pino implementation the composition roots use (§17.2); this file's console version is the
 * dependency-free fallback so a package under test needs no logging stack.
 *
 * `child` is what makes a log line answerable: bindings carry `run_id`/`task_id`/`trace_id`
 * so a line is attributable without the message having to restate them.
 */
export type Logger = Record<LogLevel, (msg: string, fields?: Record<string, unknown>) => void> & {
  child: (bindings: Record<string, unknown>) => Logger;
};

/** Minimal JSON-lines logger over console. Level from opts, else LOG_LEVEL env, else "info". */
export function createLogger(
  opts: { name?: string; level?: LogLevel; bindings?: Record<string, unknown> } = {},
): Logger {
  const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  const min = WEIGHT[opts.level ?? envLevel ?? "info"] ?? WEIGHT.info;

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (WEIGHT[level] < min) return;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      ...(opts.name ? { name: opts.name } : {}),
      ...opts.bindings,
      msg,
      ...fields,
    });
    // eslint-disable-next-line no-console -- this logger IS the console sink
    if (level === "error") console.error(line);
    // eslint-disable-next-line no-console -- this logger IS the console sink
    else if (level === "warn") console.warn(line);
    // eslint-disable-next-line no-console -- this logger IS the console sink
    else console.log(line);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (bindings) => createLogger({ ...opts, bindings: { ...opts.bindings, ...bindings } }),
  };
}
