import { tmpdir } from "node:os";
import { AppError } from "@tabductor/core";
import { initTelemetry } from "@tabductor/telemetry/init";
import { z } from "zod";
import { startRendererServer } from "./server.js";

/**
 * The renderer process: a composition root (`docs/subphases/S5e-latex-renderer.md`
 * deliverable 1), same shape as `apps/engine`/`apps/pyrunner` — calls `initTelemetry`, owns
 * its own lifecycle, and everything it starts is already system-tested (`server.ts`,
 * `sandbox.ts`). Env config is local to this app rather than `@tabductor/core`'s shared
 * `loadConfig` — nothing else in the workspace needs a sandbox image name or a wall-clock cap,
 * and growing the shared schema for one app's settings is exactly the kind of speculative
 * coupling the house rules ask to avoid.
 *
 * Deliberately **not** wired into `docker-compose.yml` in this subphase: this process needs
 * the `docker` CLI and a reachable daemon to spawn per-render sandbox containers, and nothing
 * in the workspace calls it yet (S5c/S5f wire `assets.render` into a live loop). Compose-izing
 * it today would mean mounting the host's docker socket into a container for zero live
 * callers — a real production deployment gets that wiring (and the socket-access tradeoff
 * that comes with it) when a caller actually exists to justify it. Until then this runs as a
 * plain host process — `node --import tsx apps/renderer/src/main.ts` — exactly how the tests
 * start it (`tests/system/latex-support.ts`).
 */

const ENV_SCHEMA = z.object({
  RENDERER_PORT: z.coerce.number().int().positive().default(4100),
  RENDERER_HOST: z.string().min(1).default("127.0.0.1"),
  RENDERER_SANDBOX_IMAGE: z.string().min(1).default("tabductor-renderer-sandbox:local"),
  RENDERER_WALL_CLOCK_MS: z.coerce.number().int().positive().default(20_000),
  RENDERER_MEMORY_BYTES: z.coerce.number().int().positive().default(512 * 1024 * 1024),
  RENDERER_PIDS_LIMIT: z.coerce.number().int().positive().default(64),
  RENDERER_SCRATCH_ROOT: z.string().min(1).optional(),
  RENDERER_MAX_CONCURRENT: z.coerce.number().int().positive().default(4),
});

function loadRendererConfig(env: Record<string, string | undefined>): z.output<typeof ENV_SCHEMA> {
  const parsed = ENV_SCHEMA.safeParse(env);
  if (!parsed.success) {
    throw new AppError("config_invalid", `invalid renderer environment: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

const config = loadRendererConfig(process.env);
const telemetry = await initTelemetry({ service: "tabductor-renderer" });
const log = telemetry.logger;

const server = await startRendererServer({
  sandbox: {
    image: config.RENDERER_SANDBOX_IMAGE,
    wallClockMs: config.RENDERER_WALL_CLOCK_MS,
    memoryBytes: config.RENDERER_MEMORY_BYTES,
    pidsLimit: config.RENDERER_PIDS_LIMIT,
    scratchRoot: config.RENDERER_SCRATCH_ROOT ?? tmpdir(),
  },
  logger: log,
  maxConcurrent: config.RENDERER_MAX_CONCURRENT,
  port: config.RENDERER_PORT,
  host: config.RENDERER_HOST,
});

log.info("renderer started", {
  url: server.url,
  image: config.RENDERER_SANDBOX_IMAGE,
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
