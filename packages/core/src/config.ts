import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AppError } from "./errors.js";

/**
 * An optional setting that is present-but-empty is absent. `docker compose` renders an unset
 * `${VAR:-}` as the empty string rather than omitting the variable, and `export VAR=` does the
 * same in a shell — so without this, declaring an optional setting in compose and leaving it
 * unset would fail the whole parse and take the process down, which is the opposite of what
 * "optional" is for.
 */
const optionalSecret = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://tabductor:tabductor@localhost:5434/tabductor"),
  BLOB_DIR: z.string().min(1).default(path.join(os.tmpdir(), "tabductor-blobs")),
  HARNESS_NAV_ALLOWLIST: z
    .string()
    .default("localhost,127.0.0.1")
    .transform((s) => s.split(",").map((d) => d.trim()).filter(Boolean)),
  ANTHROPIC_API_KEY: optionalSecret,
});

export type Config = z.output<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new AppError("config_invalid", `invalid environment: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
