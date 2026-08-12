import { mcpServers, type Db } from "@tabductor/db";
import { eq } from "drizzle-orm";
import { parseMcpServerConfig, type McpServerConfig } from "./config.js";

/** What `client.ts` needs to know about one configured server — the row, parsed once. */
export type McpServerSpec = {
  id: string;
  label: string;
  config: McpServerConfig;
  /** Names a row in `secrets` (S5b); `null` for a server that needs no credential. */
  secretName: string | null;
};

/** This user's configured MCP servers, parsed and ready for `createMcpRunClient`. A task's
 * grant set (which `mcp.<server>.<tool>` names it may call) is the asset registry's business
 * (`packages/agent`'s merge function) — this just loads what the user has configured. */
export async function loadMcpServers(db: Db, userId: string): Promise<McpServerSpec[]> {
  const rows = await db.select().from(mcpServers).where(eq(mcpServers.userId, userId));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    config: parseMcpServerConfig(row.transport, row.configJson),
    secretName: row.secretName,
  }));
}
