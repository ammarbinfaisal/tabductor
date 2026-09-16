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
  TABDUCTOR_DEPLOYMENT_MODE: z.enum(["local", "hosted"]).default("local"),
  TABDUCTOR_FIXTURE_MODE: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://tabductor:tabductor@localhost:5434/tabductor"),
  BLOB_ENDPOINT: z.string().url().default("http://localhost:9002"),
  BLOB_ACCESS_KEY: z.string().min(1).default("tabductor"),
  BLOB_SECRET_KEY: z.string().min(1).default("tabductor"),
  BLOB_BUCKET: z.string().min(1).default("tabductor-blobs"),
  /** Includes identity redirects and frames; account deny/approval rules still apply. */
  POLICY_NAVIGATION_MODE: z.enum(["permissive", "grant_required"]).default("permissive"),
  /**
   * Domains a browser node may navigate to, suffix-matched (`x.com` covers `api.x.com`,
   * never `notx.com`). Empty is the default and means allow all — see
   * `AllowAllGate.checkNavigation`, which short-circuits on an empty list.
   *
   * Empty rather than localhost-only so that the two launch paths agree: `docker-compose.yml`
   * passes this through with an empty fallback, and a default of `localhost,127.0.0.1` here
   * would mean a bare `node` run silently confined a browser the composed run did not. It is
   * also the honest default for the phase — the gate is `AllowAllGate`, permissive by
   * construction, and a lone allowlist that denies the first navigation of every real graph
   * is a tripwire rather than a policy. Confinement is opt-in.
   */
  HARNESS_NAV_ALLOWLIST: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((d) => d.trim()).filter(Boolean)),
  // Publish-time schema compilation picks a provider from whichever of these is set
  // (Anthropic first). SCHEMA_MODEL overrides that provider's default model id.
  ANTHROPIC_API_KEY: optionalSetting,
  OPENAI_API_KEY: optionalSetting,
  SCHEMA_MODEL: optionalSetting,
  // S5c: the secrets broker's KEK-wrapping key store (`fileKeyWrapper`, dev/test — a KMS
  // implementation is a later swap behind the same `KeyWrapper` interface, per S5b's own
  // doc). A clean checkout needs no environment (impl-phases §0's own rule for every other
  // credential here) — `fileKeyWrapper` self-initializes on first use if the file is absent.
  SECRETS_KEK_FILE_PATH: z.string().min(1).default("./data/secrets-kek.json"),
}).superRefine((config, ctx) => {
  if (config.TABDUCTOR_DEPLOYMENT_MODE === "hosted" && config.TABDUCTOR_FIXTURE_MODE) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["TABDUCTOR_FIXTURE_MODE"], message: "fixture mode is forbidden in hosted deployments" });
  }
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
