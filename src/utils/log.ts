import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";

import { mcpConfig } from "@/config";

const logCategories = [
  "mcp.calls",
  "mcp.args",
  "mcp.results",
  "mcp.errors",
  "daemon.lifecycle",
  "daemon.requests",
  "daemon.responses",
  "daemon.errors",
  "browser.requests",
  "browser.responses",
  "browser.notifications",
  "browser.errors",
] as const;

export type LogCategory = (typeof logCategories)[number];

type LogMode = "off" | "errors" | "normal" | "debug" | "full";
type LogDest = "auto" | "stderr" | "file";
type LogFormat = "text" | "json";
type LogLevel = "info" | "error";

type LogEvent = {
  timestamp: string;
  pid: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: unknown;
};

type LoggerConfig = {
  mode: LogMode;
  dest: LogDest;
  format: LogFormat;
  file: string;
  redact: boolean;
  include: string[];
  exclude: string[];
};

const modeDefaults: Record<Exclude<LogMode, "off">, string[]> = {
  errors: [
    "mcp.errors",
    "daemon.errors",
    "browser.errors",
  ],
  normal: [
    "mcp.calls",
    "mcp.errors",
    "daemon.lifecycle",
    "daemon.errors",
    "browser.errors",
  ],
  debug: [
    "mcp.calls",
    "mcp.args",
    "mcp.errors",
    "daemon.lifecycle",
    "daemon.requests",
    "daemon.responses",
    "daemon.errors",
    "browser.requests",
    "browser.responses",
    "browser.errors",
  ],
  full: ["*"],
};

const sensitiveKeys = new Set([
  "authorization",
  "cookie",
  "cookies",
  "password",
  "passwd",
  "secret",
  "token",
  "text",
  "value",
]);

function parseLogMode(value: string | undefined): LogMode {
  switch ((value ?? "").toLowerCase()) {
    case "off":
    case "errors":
    case "normal":
    case "debug":
    case "full":
      return value!.toLowerCase() as LogMode;
    default:
      return "errors";
  }
}

function parseLogDest(value: string | undefined): LogDest {
  switch ((value ?? "").toLowerCase()) {
    case "auto":
    case "stderr":
    case "file":
      return value!.toLowerCase() as LogDest;
    default:
      return "auto";
  }
}

function parseLogFormat(value: string | undefined): LogFormat {
  switch ((value ?? "").toLowerCase()) {
    case "json":
    case "text":
      return value!.toLowerCase() as LogFormat;
    default:
      return "text";
  }
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === "") {
    return defaultValue;
  }

  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return defaultValue;
  }
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchesCategory(pattern: string, category: LogCategory): boolean {
  if (pattern === "*") {
    return true;
  }

  if (pattern.endsWith(".*")) {
    return category.startsWith(pattern.slice(0, -1));
  }

  return category === pattern;
}

function selectOutputTarget(config: LoggerConfig): "stderr" | "file" {
  if (config.dest === "stderr" || config.dest === "file") {
    return config.dest;
  }

  return process.argv[2] === "daemon" ? "file" : "stderr";
}

function resolveLoggerConfig(): LoggerConfig {
  const debugEnabled = mcpConfig.log.debug;
  const fullDebugEnabled = mcpConfig.log.debugFull;

  return {
    mode: fullDebugEnabled
      ? "full"
      : debugEnabled
        ? "debug"
        : parseLogMode(mcpConfig.log.mode),
    dest: parseLogDest(mcpConfig.log.dest),
    format: parseLogFormat(mcpConfig.log.format),
    file: mcpConfig.log.file,
    redact: mcpConfig.log.redact,
    include: mcpConfig.log.include,
    exclude: mcpConfig.log.exclude,
  };
}

const loggerConfig = resolveLoggerConfig();

function isCategoryEnabled(category: LogCategory): boolean {
  if (loggerConfig.mode === "off") {
    return false;
  }

  const defaults = modeDefaults[loggerConfig.mode];
  const enabledByDefault = defaults.some((pattern) => matchesCategory(pattern, category));
  const enabledByInclude = loggerConfig.include.some((pattern) => matchesCategory(pattern, category));
  const excluded = loggerConfig.exclude.some((pattern) => matchesCategory(pattern, category));

  return (enabledByDefault || enabledByInclude) && !excluded;
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!loggerConfig.redact || value == null) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = sensitiveKeys.has(key.toLowerCase())
      ? "[REDACTED]"
      : redactValue(entry, seen);
  }
  return result;
}

function serializeForJson(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function formatText(event: LogEvent): string {
  const prefix = `[${event.timestamp}] ${event.level.toUpperCase()} ${event.category} ${event.message}`;
  if (event.data === undefined) {
    return prefix;
  }

  return `${prefix}\n${inspect(event.data, {
    depth: loggerConfig.mode === "full" ? null : 6,
    breakLength: 120,
    compact: false,
    sorted: true,
  })}`;
}

function emitLog(event: LogEvent) {
  const target = selectOutputTarget(loggerConfig);
  const line = loggerConfig.format === "json"
    ? JSON.stringify(event, (_key, value) => serializeForJson(value))
    : formatText(event);

  if (target === "stderr") {
    console.error(line);
    return;
  }

  mkdirSync(dirname(loggerConfig.file), { recursive: true });
  appendFileSync(loggerConfig.file, `${line}\n`, "utf8");
}

function writeLog(level: LogLevel, category: LogCategory, message: string, data?: unknown) {
  if (!isCategoryEnabled(category)) {
    return;
  }

  emitLog({
    timestamp: new Date().toISOString(),
    pid: process.pid,
    level,
    category,
    message,
    data: data === undefined ? undefined : redactValue(data),
  });
}

export function logInfo(category: LogCategory, message: string, data?: unknown) {
  writeLog("info", category, message, data);
}

export function logError(category: LogCategory, message: string, data?: unknown) {
  writeLog("error", category, message, data);
}

export function logException(
  category: LogCategory,
  message: string,
  error: unknown,
  data?: Record<string, unknown>,
) {
  writeLog("error", category, message, {
    ...data,
    error: error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : String(error),
  });
}

export function getLoggerConfig() {
  return {
    ...loggerConfig,
    output: selectOutputTarget(loggerConfig),
  };
}

/**
 * Logs a message to the console.
 *
 * `console.error` is used since standard input/output is used as transport for MCP.
 */
export const debugLog: typeof console.error = (...args) => {
  console.error(...args);
};
