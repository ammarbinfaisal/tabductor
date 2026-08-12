import { desc, eq } from "drizzle-orm";
import { storeSchemas, type Db, type StoreSchemaRow } from "@tabductor/db";
import type { StoreTablesSpec } from "./ddl.js";

/**
 * The store schema currently applied to `wfdata_<id>` — the highest `version` row for this
 * workflow. `store_schemas` rows are workflow-scoped, not workflow-*version*-scoped (§6.1:
 * "the store's data is the deliberate exception... shared across versions"), so unlike an
 * event's packet schema there is no per-run pinning to resolve here — every run of every task
 * in this workflow, whichever graph version it started under, sees the one schema currently
 * migrated onto the physical schema.
 */
export async function latestStoreSchema(db: Db, workflowId: string): Promise<StoreSchemaRow | undefined> {
  const [row] = await db
    .select()
    .from(storeSchemas)
    .where(eq(storeSchemas.workflowId, workflowId))
    .orderBy(desc(storeSchemas.version))
    .limit(1);
  return row;
}

export function tablesSpecOf(row: StoreSchemaRow | undefined): StoreTablesSpec {
  const raw = row?.tablesSpecJson;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as StoreTablesSpec) : {};
}
