import { loadConfig } from "@tabductor/core";
import { createDb, type Db, type DbHandle } from "@tabductor/db";

/**
 * One pool per process (S2c). Next's dev server re-evaluates modules on every edit, so the
 * handle is parked on `globalThis` — without that, an afternoon of editing leaks a pool per
 * save until Postgres runs out of connections.
 *
 * The web process only reads and writes rows. It never starts an engine, a dispatcher or a
 * scheduler: execution belongs to `apps/engine`, and the two share nothing but this database.
 */
const store = globalThis as { __tabductorDb?: DbHandle };

export function db(): Db {
  store.__tabductorDb ??= createDb(loadConfig().DATABASE_URL, { max: 5 });
  return store.__tabductorDb.db;
}

/** S5g: `workflow.publishStoreSchema`'s connection to the fenced/migrator paths
 * (`@tabductor/store`), which need a raw `pg.Pool` — same handle `db()` already parks on
 * `globalThis`, not a second pool. */
export function pool(): DbHandle["pool"] {
  store.__tabductorDb ??= createDb(loadConfig().DATABASE_URL, { max: 5 });
  return store.__tabductorDb.pool;
}
