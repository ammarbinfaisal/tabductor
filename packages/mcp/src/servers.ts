import { newId } from "@tabductor/core";
import { mcpServers, type Db } from "@tabductor/db";
import { and, eq } from "drizzle-orm";
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

export type CreateMcpServerInput = {
  userId: string;
  label: string;
  transport: string;
  configJson: unknown;
  secretName?: string | undefined;
};

export type McpServerSummary = { id: string; label: string; transport: string; secretName: string | null; createdAt: Date };

/**
 * Registers a server (U3a's settings page). `parseMcpServerConfig` runs first, so a row that
 * exists is a row `loadMcpServers` can always parse — and, by the config schemas' own
 * construction, one that carries no credential value (`config.ts`'s doc comment).
 */
export async function createMcpServer(db: Db, input: CreateMcpServerInput): Promise<McpServerSummary> {
  const config = parseMcpServerConfig(input.transport, input.configJson);
  const [row] = await db
    .insert(mcpServers)
    .values({
      id: newId("mcp"),
      userId: input.userId,
      label: input.label,
      transport: config.transport,
      configJson: input.configJson,
      secretName: input.secretName ?? null,
    })
    .returning();
  return { id: row!.id, label: row!.label, transport: row!.transport, secretName: row!.secretName, createdAt: row!.createdAt };
}

export async function deleteMcpServer(db: Db, input: { userId: string; id: string }): Promise<boolean> {
  const deleted = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.id, input.id), eq(mcpServers.userId, input.userId)))
    .returning({ id: mcpServers.id });
  return deleted.length > 0;
}

/** The settings page's list: label/transport/secret name — the config JSON stays server-side
 * (it is not secret, but there is nothing for the UI to do with it except re-show a blob). */
export async function listMcpServers(db: Db, userId: string): Promise<McpServerSummary[]> {
  const rows = await db
    .select({
      id: mcpServers.id,
      label: mcpServers.label,
      transport: mcpServers.transport,
      secretName: mcpServers.secretName,
      createdAt: mcpServers.createdAt,
    })
    .from(mcpServers)
    .where(eq(mcpServers.userId, userId));
  return rows;
}
