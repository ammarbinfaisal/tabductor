import { createTestDb, prepareTemplate } from "@tabductor/testkit";
import { createDb, migrateDb, type DbHandle } from "./client.js";

export type MigratedTestDb = DbHandle & { url: string };

/** Its own template, so suites using a different schema never clobber this one. */
const TEMPLATE = "tabductor_migrated_template";

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
