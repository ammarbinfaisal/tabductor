import { AppError, loadConfig } from "@tabductor/core";
import { createDb, migrateDb, MIGRATION_DRIFT } from "./client.js";

/**
 * `pnpm -F @tabductor/db migrate` — apply the checked-in migrations to `DATABASE_URL`.
 *
 * Its own entry point rather than something the engine does on boot: two app processes
 * starting at once would race the migration, and in `docker compose` this runs as a
 * one-shot service both of them wait on.
 *
 * A drift failure exits non-zero deliberately: that is what makes compose's
 * `service_completed_successfully` gate hold `engine` and `web` back, instead of letting
 * them boot against a schema missing tables.
 */
const { DATABASE_URL } = loadConfig();
const handle = createDb(DATABASE_URL, { max: 1 });
try {
  await migrateDb(handle.db);
  console.log(`migrated ${DATABASE_URL.replace(/\/\/[^@]*@/, "//")}`);
} catch (err) {
  if (err instanceof AppError && err.code === MIGRATION_DRIFT) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  await handle.close();
}
