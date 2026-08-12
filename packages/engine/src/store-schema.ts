import type { Pool } from "pg";
import { AppError, newId } from "@tabductor/core";
import { desc, eq } from "drizzle-orm";
import { storeSchemas, workflows, type Db, type StoreMigrationClass } from "@tabductor/db";
import {
  applyMigration,
  checkDdlShape,
  classifyMigration,
  currentSchemaVersion,
  provision,
  validateStoreSchemaArtifact,
  type DdlTable,
  type StoreTablesSpec,
} from "@tabductor/store";

/**
 * The control-plane entry point for a workflow's store-schema artifact (S5g deliverable 2,
 * graph-compilation-llm §3–4 P3's second half). A **separate** publish call from
 * `publishVersion`'s graph document, deliberately: the store schema is "fixed at save" per
 * §4.2 ("the two halves land at different moments"), and there is no S8 compiler yet to hand
 * this one artifact through the same request as the graph — wiring both into one call today
 * would invent a request shape the compiler that actually produces one hasn't been designed
 * around. `apps/web`'s `workflow.publishStoreSchema` mutation is the thin API wrapper; every
 * check here is the same one S8's save-time gate calls (`@tabductor/store`'s own doc note).
 */

export const STORE_SCHEMA_INVALID = "store_schema_invalid";
export const STORE_MIGRATION_DESTRUCTIVE = "store_migration_destructive";

export type PublishStoreSchemaInput = {
  workflowId: string;
  description?: string;
  ddl: string;
  tablesSpec: StoreTablesSpec;
  /** §6.2's confirmation flag — required when the diff classifies `destructive`, ignored
   * otherwise (an additive or no-op diff needs no confirmation to apply). */
  confirmDestructive?: boolean;
};

export type PublishStoreSchemaResult = {
  version: number;
  migrationClass: StoreMigrationClass;
  /** Human-readable diff lines, always populated — even a `none` publish states "no change"
   * so the caller can render *something* rather than an empty diff meaning two different
   * things. */
  changes: string[];
};

async function previousDdlTables(db: Db, workflowId: string): Promise<Map<string, DdlTable>> {
  const [row] = await db
    .select({ ddl: storeSchemas.ddl })
    .from(storeSchemas)
    .where(eq(storeSchemas.workflowId, workflowId))
    .orderBy(desc(storeSchemas.version))
    .limit(1);
  if (!row) return new Map();
  const parsed = checkDdlShape(row.ddl);
  // The previous row's DDL passed this exact check when it was published — a failure here
  // would mean the stored artifact itself is corrupt, not that the *new* one is invalid.
  return parsed.ok ? parsed.tables : new Map();
}

export async function publishStoreSchema(
  db: Db,
  pool: Pool,
  input: PublishStoreSchemaInput,
): Promise<PublishStoreSchemaResult> {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, input.workflowId));
  if (!workflow) {
    throw new AppError("workflow_not_found", `no workflow "${input.workflowId}"`, {
      details: { workflowId: input.workflowId },
    });
  }

  // Validation is the slow, fallible part (a real scratch-schema apply against Postgres) —
  // done before any row is written or any DDL touches `wfdata_<id>` for real, matching
  // `publishVersion`'s own "generation happens before the transaction" rule.
  const checked = await validateStoreSchemaArtifact(pool, input.ddl, input.tablesSpec);
  if (!checked.ok) {
    throw new AppError(STORE_SCHEMA_INVALID, `store schema artifact failed validation`, {
      details: { issues: checked.issues },
    });
  }

  const shape = checkDdlShape(input.ddl);
  if (!shape.ok) {
    // Unreachable given `checked.ok` above already ran the identical check — kept as a typed
    // narrowing rather than a cast, since `validateStoreSchemaArtifact` does not hand its
    // intermediate `DdlCheck` back to the caller.
    throw new AppError(STORE_SCHEMA_INVALID, "store schema artifact failed validation", {
      details: { issues: shape.issues },
    });
  }

  const previous = await previousDdlTables(db, input.workflowId);
  const diff = classifyMigration(previous, shape.tables);

  if (diff.class === "destructive" && !input.confirmDestructive) {
    throw new AppError(STORE_MIGRATION_DESTRUCTIVE, "this migration drops or narrows data; resend with confirmDestructive to apply", {
      details: { changes: diff.changes },
    });
  }

  await provision(pool, input.workflowId);

  if (diff.class === "none") {
    // Republishing an unchanged schema is free (the schema-compiler precedent, EC1/§4.2):
    // no DDL to apply, and no new `store_schemas` row either — `(workflow_id, version)` is
    // unique, and there is genuinely no new *version* to record when nothing changed. The
    // existing latest row already is this schema's record.
    return { version: await currentSchemaVersion(pool, input.workflowId), migrationClass: "none", changes: ["no change"] };
  }

  const appliedVersion = await applyMigration(pool, input.workflowId, diff.sql);
  await db.insert(storeSchemas).values({
    id: newId("storesch"),
    workflowId: input.workflowId,
    version: appliedVersion,
    descriptionText: input.description ?? "",
    ddl: input.ddl,
    tablesSpecJson: input.tablesSpec,
    migrationSql: diff.sql,
    migrationClass: diff.class,
  });

  return { version: appliedVersion, migrationClass: diff.class, changes: diff.changes };
}
