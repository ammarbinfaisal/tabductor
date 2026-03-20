import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type RawLogSettings = {
  mode?: unknown;
  dest?: unknown;
  format?: unknown;
  file?: unknown;
  redact?: unknown;
  include?: unknown;
  exclude?: unknown;
};

type RawSettingsFile = {
  host?: unknown;
  wsPort?: unknown;
  controlPort?: unknown;
  log?: RawLogSettings;
};

type ResolvedSettingsFile = {
  path?: string;
  settings: RawSettingsFile;
};

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
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
    }
  }
  return undefined;
}

function stringListValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return undefined;
}

function defaultConfigCandidates(): string[] {
  return [
    resolve(process.cwd(), "tabductor.config.json"),
    resolve(process.cwd(), ".tabductor.json"),
  ];
}

function loadSettingsFile(): ResolvedSettingsFile {
  const explicitPath = envValue("TABDUCTOR_CONFIG");
  const candidates = explicitPath ? [resolve(explicitPath)] : defaultConfigCandidates();

  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }

    const rawText = readFileSync(path, "utf8");
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Config file must contain a JSON object: ${path}`);
    }
    return {
      path,
      settings: parsed as RawSettingsFile,
    };
  }

  return {
    settings: {},
  };
}

const configFile = loadSettingsFile();
const fileSettings = configFile.settings;
const fileLogSettings = fileSettings.log ?? {};

function envNumber(name: string): number | undefined {
  return numberValue(envValue(name));
}

function envBoolean(name: string): boolean | undefined {
  return booleanValue(envValue(name));
}

function envCsv(name: string): string[] | undefined {
  return stringListValue(envValue(name));
}

export const appConfig = {
  name: "@tabductor/mcp",
  configFilePath: configFile.path,
} as const;

export const mcpConfig = {
  defaultWsPort: envNumber("TABDUCTOR_WS_PORT")
    ?? numberValue(fileSettings.wsPort)
    ?? 8765,
  defaultControlPort: envNumber("TABDUCTOR_CONTROL_PORT")
    ?? numberValue(fileSettings.controlPort)
    ?? 8766,
  defaultHost: envValue("TABDUCTOR_HOST")
    ?? stringValue(fileSettings.host)
    ?? "127.0.0.1",
  log: {
    mode: envValue("TABDUCTOR_LOG_MODE")
      ?? stringValue(fileLogSettings.mode),
    dest: envValue("TABDUCTOR_LOG_DEST")
      ?? stringValue(fileLogSettings.dest),
    format: envValue("TABDUCTOR_LOG_FORMAT")
      ?? stringValue(fileLogSettings.format),
    file: envValue("TABDUCTOR_LOG_FILE")
      ?? stringValue(fileLogSettings.file)
      ?? "/tmp/tabductor.log",
    redact: envBoolean("TABDUCTOR_LOG_REDACT")
      ?? booleanValue(fileLogSettings.redact)
      ?? true,
    include: envCsv("TABDUCTOR_LOG_INCLUDE")
      ?? stringListValue(fileLogSettings.include)
      ?? [],
    exclude: envCsv("TABDUCTOR_LOG_EXCLUDE")
      ?? stringListValue(fileLogSettings.exclude)
      ?? [],
    debug: envBoolean("TABDUCTOR_DEBUG") ?? false,
    debugFull: envBoolean("TABDUCTOR_DEBUG_FULL") ?? false,
  },
  errors: {
    noConnectedTab: "NO_CONNECTED_TAB",
    staleRef: "STALE_REF",
  },
} as const;
