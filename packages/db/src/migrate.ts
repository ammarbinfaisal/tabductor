import { loadConfig } from "@tabductor/core";
import { createDb, migrateDb } from "./client.js";

/**
 * `pnpm -F @tabductor/db migrate` — apply the checked-in migrations to `DATABASE_URL`.
 *
 * Its own entry point rather than something the engine does on boot: two app processes
 * starting at once would race the migration, and in `docker compose` this runs as a
 * one-shot service both of them wait on.
 */
const { DATABASE_URL } = loadConfig();
const handle = createDb(DATABASE_URL, { max: 1 });
try {
  await migrateDb(handle.db);
  console.log(`migrated ${DATABASE_URL.replace(/\/\/[^@]*@/, "//")}`);
} finally {
  await handle.close();
}
