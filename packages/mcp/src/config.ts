import { AppError } from "@tabductor/core";
import { z } from "zod";

/**
 * `mcp_servers.config_json` (S5c, techical_plan §13, §14) — zod-validated per transport, the
 * way every other author-supplied JSON blob in this codebase is (`stub-executor.ts`'s
 * `limits_json.stub`, same reasoning: config, not a user-authored packet schema, so zod is
 * the right tool and ajv stays reserved for packet schemas).
 *
 * **`config_json` never contains a credential value, by construction.** Neither schema below
 * has a field shaped to hold one — a server that needs an API key names the *env var* or
 * *header* it should land in (`secretEnvVar`/`secretHeader`), and the value comes from the
 * row's `secret_name`, resolved through the S5b broker at connect/call time
 * (`redeemMcpHandle`, host-side only). A config schema with no "value" field is what makes
 * the credential-hygiene property true of every row this parses, not something a reviewer
 * has to keep re-checking by convention.
 */

export const stdioConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Plain, non-secret environment variables — names *and* values, because unlike a
   * credential, neither one is sensitive on its own. */
  env: z.record(z.string(), z.string()).default({}),
  /** Where the client spawns the process from. A transport detail, not a credential —
   * absent when the server needs no particular working directory. */
  cwd: z.string().min(1).optional(),
  /** The *name* of the env var the redeemed secret lands in, when `secret_name` is set on
   * the row. Never a value — that is the whole point of this file. */
  secretEnvVar: z.string().min(1).optional(),
});
export type StdioConfig = z.infer<typeof stdioConfigSchema>;

export const httpConfigSchema = z.object({
  url: z.string().url(),
  /** The *name* of the header the redeemed secret lands in, when `secret_name` is set.
   * Defaults to the header a bearer-token API almost always wants. */
  secretHeader: z.string().min(1).default("Authorization"),
});
export type HttpConfig = z.infer<typeof httpConfigSchema>;

export type McpServerConfig = ({ transport: "stdio" } & StdioConfig) | ({ transport: "http" } & HttpConfig);

export function parseMcpServerConfig(transport: string, configJson: unknown): McpServerConfig {
  if (transport === "stdio") {
    const parsed = stdioConfigSchema.safeParse(configJson);
    if (!parsed.success) {
      throw new AppError("mcp_config_invalid", `invalid stdio mcp config: ${parsed.error.message}`, {
        details: { transport, issues: parsed.error.issues },
      });
    }
    return { transport: "stdio", ...parsed.data };
  }
  if (transport === "http") {
    const parsed = httpConfigSchema.safeParse(configJson);
    if (!parsed.success) {
      throw new AppError("mcp_config_invalid", `invalid http mcp config: ${parsed.error.message}`, {
        details: { transport, issues: parsed.error.issues },
      });
    }
    return { transport: "http", ...parsed.data };
  }
  throw new AppError("mcp_config_invalid", `unknown mcp transport "${transport}"`, { details: { transport } });
}
