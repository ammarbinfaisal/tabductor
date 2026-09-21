import type { Pool } from "pg";
import { AppError, newId } from "@tabductor/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import { runs, storeSchemas, tasks, workflowExecutions, workflowVersions, workflows, type Db, type StoreMigrationClass } from "@tabductor/db";
import {
  applyMigrationInTransaction,
  checkDdlShape,
  classifyMigration,
  provision,
  validateStoreSchemaArtifact,
  type DdlTable,
  type StoreTablesSpec,
} from "@tabductor/store";

/**
 * The control-plane entry point for a workflow's store-schema artifact (S5g deliverable 2,
 * graph-compilation-llm §3–4 P3's second half). S8's `publishVersion` routes its compiled
 * store artifact through this function before activating the graph and pins the returned
 * schema row on that workflow version. `apps/web` also exposes `workflow.publishStoreSchema`
 * as a lower-level administration path. Both callers therefore share validation, migration
 * classification, destructive confirmation, and drain policy.
 */

export const STORE_SCHEMA_INVALID = "store_schema_invalid";
export const STORE_MIGRATION_DESTRUCTIVE = "store_migration_destructive";
export const STORE_MIGRATION_BUSY = "store_migration_busy";

export type PublishStoreSchemaInput = {
  workflowId: string;
  description?: string;
  ddl: string;
  tablesSpec: StoreTablesSpec;
  /** §6.2's confirmation flag — required when the diff classifies `destructive`, ignored
   * otherwise (an additive or no-op diff needs no confirmation to apply). */
  confirmDestructive?: boolean;
  /** Override the default drain policy and migrate while older-version runs are active. */
  forceDestructive?: boolean;
};

export type PublishStoreSchemaResult = {
  schemaId: string;
  version: number;
  migrationClass: StoreMigrationClass;
  /** Human-readable diff lines, always populated — even a `none` publish states "no change"
   * so the caller can render *something* rather than an empty diff meaning two different
   * things. */
  changes: string[];
};

async function previousStoreSchema(db: Db, workflowId: string) {
  const [row] = await db
    .select({ id: storeSchemas.id, ddl: storeSchemas.ddl, version: storeSchemas.version })
    .from(storeSchemas)
    .where(eq(storeSchemas.workflowId, workflowId))
    .orderBy(desc(storeSchemas.version))
    .limit(1);
  if (!row) return null;
  const parsed = checkDdlShape(row.ddl);
  // The previous row's DDL passed this exact check when it was published — a failure here
  // would mean the stored artifact itself is corrupt, not that the *new* one is invalid.
  return { ...row, tables: parsed.ok ? parsed.tables : new Map<string, DdlTable>() };
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

  await provision(pool, input.workflowId);
  return db.transaction(async (db) => {
    // Trigger admission takes this same lock before creating an execution. No new
    // execution can slip between the drain check and incompatible DDL publication.
    await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.id, input.workflowId)).for("update");
    const previous = await previousStoreSchema(db, input.workflowId);
    const diff = classifyMigration(previous?.tables ?? new Map(), shape.tables);

    if (diff.class === "destructive" && !input.confirmDestructive) {
      throw new AppError(STORE_MIGRATION_DESTRUCTIVE, "this migration drops or narrows data; resend with confirmDestructive to apply", {
        details: { changes: diff.changes },
      });
    }
    if (diff.class === "destructive") {
      const activeExecutions = await db.select({ id: workflowExecutions.id }).from(workflowExecutions).where(and(
        eq(workflowExecutions.workflowId, input.workflowId), eq(workflowExecutions.status, "running"),
      ));
      if (activeExecutions.length) {
        throw new AppError(STORE_MIGRATION_BUSY, "destructive migration is waiting for active executions to drain", {
          details: { activeExecutions: activeExecutions.map((execution) => execution.id), changes: diff.changes },
        });
      }
    }
    if (diff.class === "destructive" && !input.forceDestructive) {
      const active = await db
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(tasks, eq(tasks.id, runs.taskId))
        .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
        .where(and(
          eq(workflowVersions.workflowId, input.workflowId),
          inArray(runs.status, ["queued", "running", "awaiting_approval", "awaiting_human"]),
        ));
      if (active.length > 0) {
        throw new AppError(STORE_MIGRATION_BUSY, "destructive migration is waiting for active runs to drain", {
          details: { activeRuns: active.map((run) => run.id), changes: diff.changes },
        });
      }
    }

    if (diff.class === "none") {
      // Republishing an unchanged schema is free (the schema-compiler precedent, EC1/§4.2):
      // no DDL to apply, and no new `store_schemas` row either — `(workflow_id, version)` is
      // unique, and there is genuinely no new *version* to record when nothing changed. The
      // existing latest row already is this schema's record.
      if (!previous) {
        throw new AppError(STORE_SCHEMA_INVALID, "an empty store schema has no version to pin");
      }
      return { schemaId: previous.id, version: previous.version, migrationClass: "none", changes: ["no change"] };
    }

    const appliedVersion = await applyMigrationInTransaction(db, input.workflowId, diff.sql);
    const [stored] = await db.insert(storeSchemas).values({
      id: newId("storesch"),
      workflowId: input.workflowId,
      version: appliedVersion,
      descriptionText: input.description ?? "",
      ddl: input.ddl,
      tablesSpecJson: input.tablesSpec,
      migrationSql: diff.sql,
      migrationClass: diff.class,
    }).returning({ id: storeSchemas.id });

    return { schemaId: stored!.id, version: appliedVersion, migrationClass: diff.class, changes: diff.changes };
  });
}
