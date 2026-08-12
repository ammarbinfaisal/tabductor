import type { Pool } from "pg";
import { checkDdlShape, checkTablesSpecBijective, type DdlIssue, type StoreTablesSpec } from "./ddl.js";
import { validateDdlApplies } from "./provision.js";

export type ArtifactCheck = { ok: true } | { ok: false; issues: DdlIssue[] };

/**
 * Deliverable 1's full artifact gate, composed: structural shape → bijection with the
 * author's table spec → "applies cleanly to a scratch schema, rolled back". Each stage short-
 * circuits the next — there is no point paying for a real `CREATE TABLE` against Postgres
 * when the DDL already fails a check that never opens a connection.
 */
export async function validateStoreSchemaArtifact(
  pool: Pool,
  ddl: string,
  tablesSpec: StoreTablesSpec,
): Promise<ArtifactCheck> {
  const shape = checkDdlShape(ddl);
  if (!shape.ok) return { ok: false, issues: shape.issues };

  const bijectionIssues = checkTablesSpecBijective(shape.tables, tablesSpec);
  if (bijectionIssues.length > 0) return { ok: false, issues: bijectionIssues };

  const applied = await validateDdlApplies(pool, ddl);
  if (!applied.ok) return { ok: false, issues: [{ message: applied.error }] };

  return { ok: true };
}
