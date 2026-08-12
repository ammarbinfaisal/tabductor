import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { createTestDb, prepareTemplate } from "@tabductor/testkit";
import { createDb, migrateDb, migrationsFolder, type DbHandle } from "./client.js";

export type MigratedTestDb = DbHandle & { url: string };

/**
 * The template name is suffixed with a hash of the migrations directory's own file list, not
 * a fixed string. Parallel-worktree development hits a case a fixed name does not handle: two
 * checkouts with *different, both-valid* migration sets (e.g. two subphases landing side by
 * side, each in its own worktree) share this one Postgres container (`ROADMAP.md`'s
 * `localhost:5434`), and `prepareTemplate` unconditionally drops and rebuilds whatever
 * database this name points at. A fixed name means whichever worktree's test run prepares the
 * template *last* silently wins, and the other worktree's next `INSERT` fails against tables
 * that were never dropped from the schema — they were dropped from a *different* checkout's
 * template. Hashing the migration file list keeps the cache's whole point (repeat runs in the
 * same checkout still clone instead of re-migrating) while giving two divergent migration
 * sets two different databases instead of one contested one.
 */
const migrationSetHash = createHash("sha256")
  .update(readdirSync(migrationsFolder).sort().join(","))
  .digest("hex")
  .slice(0, 12);
const TEMPLATE = `tabductor_migrated_template_${migrationSetHash}`;

let template: Promise<void> | undefined;

/**
 * A fresh migrated database per test. The migrations run once per process against the
 * template DB; every call after that is a cheap `CREATE DATABASE ... TEMPLATE`.
 *
 * Lives in `packages/db` rather than testkit on purpose: this function is *about* migrating
 * and cloning `@tabductor/db`'s own schema, which is testkit's business to consume, not to
 * own. (S3b's `ScriptedBrowserExecutor` gave testkit its own, separate reasons to depend on
 * `@tabductor/db`/`@tabductor/browser`/`@tabductor/engine` — it drives the real session/pool
 * stack a test wires up — so this file and `apps/testkit` now form a cycle at the package
 * level. It resolves safely: every cyclic edge is a re-export or a value used only inside a
 * function body, never read at module top level, which is what ESM's live bindings need to
 * settle a cycle without either side seeing the other half-initialized.)
 */
export async function createMigratedTestDb(): Promise<MigratedTestDb> {
  template ??= prepareTemplate(async (url) => {
    const handle = createDb(url, { max: 1 });
    try {
      await migrateDb(handle.db);
    } finally {
      await handle.close();
    }
  }, TEMPLATE);
  await template;

  const test = await createTestDb(TEMPLATE);
  const handle = createDb(test.url);
  return {
    ...handle,
    url: test.url,
    close: async () => {
      await handle.close();
      await test.drop();
    },
  };
}
