import { readFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "@tabductor/core";
import { createDb, migrateDb, migrationsFolder, MIGRATION_DRIFT } from "@tabductor/db";
import { createTestDb, type TestDb } from "@tabductor/testkit";
import { sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

/**
 * Drizzle's migrator keeps a single high-water mark rather than a per-migration ledger, so a
 * ledger row from another checkout silently suppresses every migration at or below it — the
 * migrator resolves, the process exits 0, and the app boots against a schema missing tables.
 * These tests drive that exact shape: the guard exists because it already happened here.
 *
 * `createTestDb` with a template name this process never prepared falls through to a plain
 * `CREATE DATABASE`, which is the unmigrated database these cases need.
 */
const UNMIGRATED = "tabductor_template_never_prepared";

type JournalEntry = { idx: number; when: number; tag: string };

function entries(): JournalEntry[] {
  const raw = readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

let created: TestDb[] = [];

async function freshDb(): Promise<TestDb> {
  const db = await createTestDb(UNMIGRATED);
  created.push(db);
  return db;
}

afterEach(async () => {
  const all = created;
  created = [];
  await Promise.all(all.map((d) => d.drop()));
});

it("a clean migrate passes the drift check, and is idempotent", async () => {
  const test = await freshDb();
  const handle = createDb(test.url, { max: 1 });
  try {
    await migrateDb(handle.db);
    // The second call applies nothing; the guard must still find every journal entry.
    await migrateDb(handle.db);
    const rows = await handle.db.execute<{ n: string }>(
      sql`select count(*)::text as n from drizzle.__drizzle_migrations`,
    );
    expect(Number(rows.rows[0]?.n)).toBe(entries().length);
  } finally {
    await handle.close();
  }
});

it("fails loudly when a foreign ledger row suppresses every migration", async () => {
  const test = await freshDb();
  const handle = createDb(test.url, { max: 1 });
  const journal = entries();
  const beyond = Math.max(...journal.map((e) => e.when)) + 1;
  try {
    // A row as another checkout would have left it: newer than anything we ship, so drizzle's
    // high-water comparison skips our entire migration set without applying a thing.
    await handle.db.execute(sql`create schema if not exists drizzle`);
    await handle.db.execute(sql`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key, hash text not null, created_at bigint
      )`);
    await handle.db.execute(sql`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values ('not-a-migration-we-ship', ${beyond})`);

    const err = await migrateDb(handle.db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    const app = err as AppError;
    expect(app.code).toBe(MIGRATION_DRIFT);
    // Every tag we ship is unaccounted for, and the orphan that caused it is named.
    expect(app.details.missing).toHaveLength(journal.length);
    expect(app.message).toContain(journal[0]!.tag);
    expect(app.message).toContain(String(beyond));
    // The remedy is in the message, not only in a doc.
    expect(app.message).toContain("docker compose down -v");

    // The schema really is missing — the guard is not crying wolf over a healthy database.
    const tables = await handle.db.execute<{ n: string }>(
      sql`select count(*)::text as n from information_schema.tables where table_schema = 'public'`,
    );
    expect(Number(tables.rows[0]?.n)).toBe(0);
  } finally {
    await handle.close();
  }
});

it("fails when a migration's SQL changed after it was applied", async () => {
  const test = await freshDb();
  const handle = createDb(test.url, { max: 1 });
  const first = entries()[0]!;
  try {
    await migrateDb(handle.db);
    // Same identity, different content: what editing a checked-in .sql file looks like from
    // the ledger's side. Drizzle itself would never notice — it only compares timestamps.
    await handle.db.execute(sql`
      update drizzle.__drizzle_migrations set hash = 'edited-after-the-fact'
      where created_at = ${first.when}`);

    const err = await migrateDb(handle.db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    const app = err as AppError;
    expect(app.code).toBe(MIGRATION_DRIFT);
    expect(app.details.drifted).toEqual([first.tag]);
    expect(app.details.missing).toEqual([]);
  } finally {
    await handle.close();
  }
});
