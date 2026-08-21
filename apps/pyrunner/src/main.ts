import { tmpdir } from "node:os";
import { AppError } from "@tabductor/core";
import { initTelemetry } from "@tabductor/telemetry/init";
import { z } from "zod";
import { startPyrunnerServer } from "./server.js";

/**
 * The Python compute runner: a composition root, same shape as `apps/engine`/`apps/renderer` —
 * `initTelemetry`, its own lifecycle, an app-local env schema rather than a growth of
 * `@tabductor/core`'s shared `loadConfig` (nothing else needs an interpreter path or an output
 * cap).
 *
 * Unlike `apps/renderer` this **is** in `docker-compose.yml`, and can be, because it needs no
 * docker socket: after the S5h reshape a job is a subprocess of this process, not a container
 * this process launches. The pyrunner container is itself the isolation unit. It publishes no
 * ports and sits on an internal compose network — hygiene, not a boundary; the wall clock in
 * `job.ts` is the only runtime control there is.
 *
 * No metrics are recorded here. The host side records them
 * (`packages/engine/src/python-executor.ts`), the same split `render_duration_seconds` already
 * follows — recording in both places would double-count every job.
 */

const ENV_SCHEMA = z.object({
  PYRUNNER_PORT: z.coerce.number().int().positive().default(4200),
  /** Loopback by default, like every other bind here; compose sets 0.0.0.0 because the engine
   * must reach it across the compose network. */
  PYRUNNER_HOST: z.string().min(1).default("127.0.0.1"),
  PYRUNNER_PYTHON: z.string().min(1).default("python3"),
  PYRUNNER_WALL_CLOCK_MS: z.coerce.number().int().positive().default(60_000),
  PYRUNNER_SCRATCH_ROOT: z.string().min(1).optional(),
  PYRUNNER_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
  PYRUNNER_MAX_OUTPUT_FILES: z.coerce.number().int().positive().default(64),
  PYRUNNER_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(32 * 1024 * 1024),
  PYRUNNER_MAX_FILE_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024),
  PYRUNNER_MAX_EMIT_LINES: z.coerce.number().int().positive().default(1_000),
  PYRUNNER_MAX_EMIT_BYTES: z.coerce.number().int().positive().default(4 * 1024 * 1024),
  PYRUNNER_MAX_LOG_BYTES: z.coerce.number().int().positive().default(256 * 1024),
});

function loadPyrunnerConfig(env: Record<string, string | undefined>): z.output<typeof ENV_SCHEMA> {
  const parsed = ENV_SCHEMA.safeParse(env);
  if (!parsed.success) {
    throw new AppError("config_invalid", `invalid pyrunner environment: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

const config = loadPyrunnerConfig(process.env);
const telemetry = await initTelemetry({ service: "tabductor-pyrunner" });
const log = telemetry.logger;

const server = await startPyrunnerServer({
  job: {
    python: config.PYRUNNER_PYTHON,
    wallClockMs: config.PYRUNNER_WALL_CLOCK_MS,
    scratchRoot: config.PYRUNNER_SCRATCH_ROOT ?? tmpdir(),
    maxOutputFiles: config.PYRUNNER_MAX_OUTPUT_FILES,
    maxOutputBytes: config.PYRUNNER_MAX_OUTPUT_BYTES,
    maxFileBytes: config.PYRUNNER_MAX_FILE_BYTES,
    maxEmitLines: config.PYRUNNER_MAX_EMIT_LINES,
    maxEmitBytes: config.PYRUNNER_MAX_EMIT_BYTES,
    maxLogBytes: config.PYRUNNER_MAX_LOG_BYTES,
    keepJobs: false,
  },
  logger: log,
  maxConcurrent: config.PYRUNNER_MAX_CONCURRENT,
  port: config.PYRUNNER_PORT,
  host: config.PYRUNNER_HOST,
});

log.info("pyrunner started", {
  url: server.url,
  python: config.PYRUNNER_PYTHON,
  telemetry: telemetry.enabled ? "exporting" : "disabled",
});

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  try {
    await server.close();
    await telemetry.shutdown();
  } catch (err) {
    log.error("shutdown failed", { error: String(err) });
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: String(reason) }));
