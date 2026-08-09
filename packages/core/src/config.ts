import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AppError } from "./errors.js";

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
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
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
