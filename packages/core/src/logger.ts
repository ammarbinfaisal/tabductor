export type LogLevel = "debug" | "info" | "warn" | "error";

const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = Record<LogLevel, (msg: string, fields?: Record<string, unknown>) => void>;

/** Minimal JSON-lines logger over console. Level from opts, else LOG_LEVEL env, else "info". */
export function createLogger(opts: { name?: string; level?: LogLevel } = {}): Logger {
  const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  const min = WEIGHT[opts.level ?? envLevel ?? "info"] ?? WEIGHT.info;

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (WEIGHT[level] < min) return;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      ...(opts.name ? { name: opts.name } : {}),
      msg,
      ...fields,
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
