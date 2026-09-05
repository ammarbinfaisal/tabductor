import { createMcpServer, deleteMcpServer, listMcpServers } from "@tabductor/mcp/servers";
import { MCP_TRANSPORTS } from "@tabductor/db";
import { z } from "zod";
import { LOCAL_USER, procedure, router } from "../trpc.js";

/**
 * MCP server registration (U3a): the settings surface over `mcp_servers`. Every asset-node
 * run loads this user's whole list (`asset-executor.ts` → `loadMcpServers`), so registering
 * a server here is what makes its tools appear in the next asset run — no per-task grant
 * exists until S7.
 *
 * The config JSON is validated by `parseMcpServerConfig` inside `createMcpServer`, and its
 * schemas have no field that could hold a credential value — a server that needs one names
 * a `secrets` row via `secretName` (S5b) and the broker injects it host-side.
 */
export const mcpRouter = router({
  list: procedure.query(({ ctx }) => listMcpServers(ctx.db, LOCAL_USER)),

  create: procedure
    .input(
      z.object({
        label: z.string().trim().min(1).max(120),
        transport: z.enum(MCP_TRANSPORTS),
        configJson: z.record(z.unknown()),
        secretName: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      createMcpServer(ctx.db, {
        userId: LOCAL_USER,
        label: input.label,
        transport: input.transport,
        configJson: input.configJson,
        ...(input.secretName ? { secretName: input.secretName } : {}),
      }),
    ),

  remove: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => ({ removed: await deleteMcpServer(ctx.db, { userId: LOCAL_USER, id: input.id }) })),
});
