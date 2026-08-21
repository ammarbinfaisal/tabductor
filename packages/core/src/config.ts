import { z } from "zod";
import { AppError } from "./errors.js";

/**
 * An optional setting that is present-but-empty is absent. `docker compose` renders an unset
 * `${VAR:-}` as the empty string rather than omitting the variable, and `export VAR=` does the
 * same in a shell — so without this, declaring an optional setting in compose and leaving it
 * unset would fail the whole parse and take the process down, which is the opposite of what
 * "optional" is for.
 */
const optionalSetting = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://tabductor:tabductor@localhost:5434/tabductor"),
  BLOB_ENDPOINT: z.string().url().default("http://localhost:9002"),
  BLOB_ACCESS_KEY: z.string().min(1).default("tabductor"),
  BLOB_SECRET_KEY: z.string().min(1).default("tabductor"),
  BLOB_BUCKET: z.string().min(1).default("tabductor-blobs"),
  HARNESS_NAV_ALLOWLIST: z
    .string()
    .default("localhost,127.0.0.1")
    .transform((s) => s.split(",").map((d) => d.trim()).filter(Boolean)),
  // Publish-time schema compilation picks a provider from whichever of these is set
  // (Anthropic first). SCHEMA_MODEL overrides that provider's default model id.
  ANTHROPIC_API_KEY: optionalSetting,
  OPENAI_API_KEY: optionalSetting,
  SCHEMA_MODEL: optionalSetting,
  /** S5h: `apps/pyrunner`'s base URL. Unset withholds the `(asset, python)` executor, the same
   * posture the AI executors take without a key — a mode with nowhere to run is declined at
   * boot with a log line, not registered to fail deep inside a run. */
  PYRUNNER_URL: optionalSetting,
  // S5c: the secrets broker's KEK-wrapping key store (`fileKeyWrapper`, dev/test — a KMS
  // implementation is a later swap behind the same `KeyWrapper` interface, per S5b's own
  // doc). A clean checkout needs no environment (impl-phases §0's own rule for every other
  // credential here) — `fileKeyWrapper` self-initializes on first use if the file is absent.
  SECRETS_KEK_FILE_PATH: z.string().min(1).default("./data/secrets-kek.json"),
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
