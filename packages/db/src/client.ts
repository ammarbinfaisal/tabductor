import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "@tabductor/core";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export type DbHandle = {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
};

/** Generated SQL lives next to the package, not next to the compiled output. */
export const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

export const MIGRATION_DRIFT = "migration_drift";

type JournalEntry = { idx: number; when: number; tag: string };

/**
 * What drizzle wrote, as it writes it. `readMigrationFiles` hashes the **whole raw `.sql`
 * file** — `--> statement-breakpoint` markers and all — before splitting it, and stores
 * `journal.when` as `created_at`. Recomputing the hash the same way is the only way to tell
 * "this migration ran" from "a migration with the same name ran".
 */
function journalEntries(): JournalEntry[] {
  const raw = readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8");
  const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
  return parsed.entries ?? [];
}

function hashOf(tag: string): string {
  const query = readFileSync(path.join(migrationsFolder, `${tag}.sql`)).toString();
  return createHash("sha256").update(query).digest("hex");
}

/**
 * Fails loudly when the checked-in migrations and the database's ledger disagree.
 *
 * Drizzle's migrator keeps a **single high-water mark**, not a per-migration ledger:
 * `select ... order by created_at desc limit 1`, then apply only where
 * `last.created_at < migration.folderMillis`. One row from another checkout — a parallel
 * worktree, a branch carrying its own `0015` — pushes that mark past ours, and every
 * migration at or below it is skipped **in silence**. The migrator resolves, the process
 * exits 0, compose reports `service_completed_successfully`, and the app boots against a
 * schema missing tables. This project builds subphases in parallel worktrees and renumbers
 * migrations at merge, so that is not a hypothetical: it is how a dev volume here ended up
 * with `asset_versions` present and its ledger row unaccounted for.
 *
 * Lives inside `migrateDb` rather than in the CLI so neither caller — `migrate.ts` or
 * `test-db.ts` — can forget it, and so a future caller inherits it for free.
 */
async function verifyMigrationsApplied(db: Db): Promise<void> {
  const entries = journalEntries();
  const result = await db.execute<{ hash: string; created_at: string }>(
    sql`select hash, created_at from drizzle.__drizzle_migrations`,
  );
  // `created_at` is bigint, which node-postgres hands back as a string. Comparing it to a
  // number would silently never match.
  const rows = result.rows.map((r) => ({ hash: r.hash, createdAt: String(r.created_at) }));
  const byCreatedAt = new Map(rows.map((r) => [r.createdAt, r.hash]));

  const missing: JournalEntry[] = [];
  const drifted: JournalEntry[] = [];
  for (const entry of entries) {
    const seen = byCreatedAt.get(String(entry.when));
    if (seen === undefined) missing.push(entry);
    else if (seen !== hashOf(entry.tag)) drifted.push(entry);
  }
  const known = new Set(entries.map((e) => String(e.when)));
  const orphans = rows.filter((r) => !known.has(r.createdAt));

  if (missing.length === 0 && drifted.length === 0) return;

  const lines = ["migration drift — the checked-in migrations do not match this database.", ""];
  if (missing.length > 0) {
    lines.push(`never applied (${missing.length}):`);
    for (const e of missing) lines.push(`  ${e.tag}  when=${e.when}  sha256=${hashOf(e.tag)}`);
    lines.push("");
  }
  if (drifted.length > 0) {
    lines.push(`content changed since it was applied (${drifted.length}):`);
    for (const e of drifted) lines.push(`  ${e.tag}  when=${e.when}  sha256=${hashOf(e.tag)}`);
    lines.push("");
  }
  if (orphans.length > 0) {
    lines.push(`applied here but absent from this checkout (${orphans.length}):`);
    for (const r of orphans) lines.push(`  created_at=${r.createdAt}  hash=${r.hash}`);
    lines.push("");
  }
  lines.push(
    "Drizzle's migrator keeps a single high-water mark, not a per-migration ledger: it applies",
    "a migration only when the newest created_at in drizzle.__drizzle_migrations is *older*",
    "than that migration's journal `when`. One row from another checkout pushes that mark past",
    "ours, and every migration at or below it is skipped in silence.",
    "",
    "Development volume — discard and re-migrate:",
    "    docker compose down -v && docker compose up -d",
    "",
    "Instance whose data must be kept — apply each file above by hand, then insert its row:",
    "    psql \"$DATABASE_URL\" -f packages/db/migrations/<tag>.sql",
    "    psql \"$DATABASE_URL\" -c \"insert into drizzle.__drizzle_migrations (hash, created_at)",
    "        values ('<sha256 above>', <when above>)\"",
    "  (the sha256 is of the .sql file exactly as checked in — do not edit it first)",
  );
  throw new AppError(MIGRATION_DRIFT, lines.join("\n"), {
    details: {
      missing: missing.map((e) => e.tag),
      drifted: drifted.map((e) => e.tag),
      orphans: orphans.map((r) => r.createdAt),
    },
  });
}

/** Applies the checked-in drizzle-kit migrations. Safe to call repeatedly. */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
  await verifyMigrationsApplied(db);
}
