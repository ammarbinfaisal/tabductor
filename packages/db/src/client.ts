import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** Applies the checked-in drizzle-kit migrations. Safe to call repeatedly. */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
