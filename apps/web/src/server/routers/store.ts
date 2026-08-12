import { AppError } from "@tabductor/core";
import { getWorkflow, STORE_SCHEMA_INVALID } from "@tabductor/engine";
import {
  checkDdlShape,
  classifyMigration,
  latestStoreSchema,
  runStoreQuery,
  tablesSpecOf,
  type DdlTable,
  type MigrationDiff,
} from "@tabductor/store";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { procedure, router } from "../trpc.js";
import { storeTableSpecSchema } from "./workflow.js";

/**
 * U3.5 — the store browser + query console's backend. Every procedure here is thin
 * composition over `@tabductor/store`'s already-fenced, already-tested primitives
 * (graph-compilation-llm §3.5, S5g): this file adds no new query path, no new role, no new
 * connection. `overview`'s row counts and `query`'s console both call `runStoreQuery` — the
 * exact function `store.query` the decision node's tool registers (`packages/store/src/tools.ts`)
 * — so the console is not "as safe as" `store.query`, it *is* `store.query`, called with a
 * workflow id from the URL instead of an agent's tool call.
 */

async function requireWorkflow(ctx: { db: Parameters<typeof getWorkflow>[0] }, workflowId: string): Promise<void> {
  const workflow = await getWorkflow(ctx.db, workflowId);
  if (!workflow) throw new TRPCError({ code: "NOT_FOUND", message: `no workflow "${workflowId}"` });
}

function requirePool<T extends { pool?: unknown }>(ctx: T): asserts ctx is T & { pool: NonNullable<T["pool"]> } {
  if (!ctx.pool) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "no pool configured for this context" });
}

/** `checkDdlShape` on the previous published version's DDL, or an empty table map for a
 * workflow whose store has never been published — the same "nothing to diff against" base
 * case `store-schema.ts`'s own `previousDdlTables` starts from (S5g deviation-free logic,
 * restated here rather than imported: that helper is not exported, and duplicating four
 * lines of read-only lookup is cheaper than widening `packages/engine`'s surface for a UI
 * slice's preview button — see U3.5's territory note). */
async function previousDdlTables(ctx: { db: Parameters<typeof getWorkflow>[0] }, workflowId: string): Promise<Map<string, DdlTable>> {
  const row = await latestStoreSchema(ctx.db, workflowId);
  if (!row) return new Map();
  const parsed = checkDdlShape(row.ddl);
  return parsed.ok ? parsed.tables : new Map();
}

export const storeRouter = router({
  /**
   * The store browser (deliverable 1): the workflow's current store-schema version and, per
   * table, its declared shape and a live row count. Row counts are not a second read path —
   * each is one `select count(*)` sent through `runStoreQuery`, so a table whose count the
   * fence would refuse to answer (it never would; `count(*)` is always a plain SELECT) fails
   * the same visible way a hostile console query does, rather than a silent zero.
   */
  overview: procedure.input(z.object({ workflowId: z.string().min(1) })).query(async ({ ctx, input }) => {
    await requireWorkflow(ctx, input.workflowId);

    const schemaRow = await latestStoreSchema(ctx.db, input.workflowId);
    if (!schemaRow) return { schemaVersion: null, description: "", tables: [] };

    requirePool(ctx);
    const spec = tablesSpecOf(schemaRow);

    const tables = await Promise.all(
      Object.entries(spec).map(async ([name, tableSpec]) => {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        const result = await runStoreQuery(ctx.pool, input.workflowId, `select count(*) as n from ${quoted}`, {
          metrics: ctx.metrics,
        });
        const properties = (tableSpec.schema as { properties?: Record<string, unknown> } | undefined)?.properties;
        const columns = properties && typeof properties === "object" ? Object.keys(properties) : [];
        return {
          name,
          primaryKey: tableSpec.primaryKey,
          columns,
          rowCount: result.ok ? Number(result.rows[0]?.n ?? 0) : null,
          rowCountError: result.ok ? null : result.error,
        };
      }),
    );

    return { schemaVersion: schemaRow.version, description: schemaRow.descriptionText, tables };
  }),

  /**
   * The query console (deliverable 1's security-critical piece). `sql` is owner-supplied and
   * unparsed until it reaches `runStoreQuery`, which runs the *exact* three layers
   * `store.query` runs for a decision node — parse gate, reader role + READ ONLY transaction
   * + pinned search_path, N+1 row cap — with no client-controlled override of the cap or the
   * timeout (a "hostile limit" has nothing to widen: the router never forwards one). A
   * rejected query is returned as ordinary data (`StoreQueryResult`'s `ok: false` branch, the
   * fence's own typed reason/error), never thrown — surfaced in the UI, never a 500.
   */
  query: procedure
    .input(z.object({ workflowId: z.string().min(1), sql: z.string().min(1).max(10_000) }))
    .query(async ({ ctx, input }) => {
      await requireWorkflow(ctx, input.workflowId);
      requirePool(ctx);
      return runStoreQuery(ctx.pool, input.workflowId, input.sql, { metrics: ctx.metrics });
    }),

  /**
   * Schema-diff preview (deliverable 1's third piece): `publishStoreSchema`'s own
   * validate → classify sequence (`packages/engine/src/store-schema.ts`), stopping before
   * `provision`/`applyMigration` — nothing here touches `wfdata_*` or writes a
   * `store_schemas` row. The publish flow's diff panel calls this first; `confirmDestructive`
   * is still `publishStoreSchema`'s own gate at the actual publish, unchanged.
   */
  previewMigration: procedure
    .input(
      z.object({
        workflowId: z.string().min(1),
        ddl: z.string().min(1),
        tablesSpec: z.record(z.string(), storeTableSpecSchema),
      }),
    )
    .query(async ({ ctx, input }): Promise<MigrationDiff> => {
      await requireWorkflow(ctx, input.workflowId);

      const shape = checkDdlShape(input.ddl);
      if (!shape.ok) {
        throw new AppError(STORE_SCHEMA_INVALID, "store schema artifact failed validation", {
          details: { issues: shape.issues },
        });
      }

      const previous = await previousDdlTables(ctx, input.workflowId);
      return classifyMigration(previous, shape.tables);
    }),
});
