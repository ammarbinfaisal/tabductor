import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Builds a stdio `config_json` for the fake MCP server (`mcp-fake-server.ts`) — the shape a
 * test inserts into an `mcp_servers` row, exactly as `packages/mcp/src/config.ts`'s
 * `stdioConfigSchema` expects it. `command: process.execPath` + `--import tsx` is the same
 * pattern `docker-compose.yml` uses to run this repo's own TS entry points without a build
 * step; `cwd` is the repo root so the bare `"tsx"` import specifier resolves against this
 * workspace's `node_modules` regardless of the spawning test's own working directory.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/testkit/src -> repo root.
const repoRoot = path.resolve(here, "..", "..", "..");
const serverScript = path.join(here, "mcp-fake-server.ts");

/** The exact bytes `imageStub` returns — tests assert against this rather than re-deriving
 * it, so a change to the fixture is a one-line diff instead of a silent divergence. */
export const FAKE_MCP_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export type FakeMcpServerConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
};

export type FakeMcpServerOptions = {
  /** When set, the spawned server requires *this* env var name to carry a non-empty value
   * before any tool call succeeds — the credential-hygiene test's fixture. The client
   * (`packages/mcp`) is what actually sets that named var, from a redeemed secret, via the
   * `secretEnvVar` field on the same `config_json`. */
  requireKeyEnv?: string;
};

export function fakeMcpServerConfig(opts: FakeMcpServerOptions = {}): FakeMcpServerConfig {
  return {
    command: process.execPath,
    args: ["--import", "tsx", serverScript],
    env: opts.requireKeyEnv ? { FAKE_MCP_REQUIRE_KEY_ENV: opts.requireKeyEnv } : {},
    cwd: repoRoot,
  };
}
