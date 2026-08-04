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
 * Lives in `packages/db` rather than testkit on purpose: testkit stays dependency-free of
 * the data layer, and the dependency points the way the workspace already allows
 * (db devDepends on testkit, never the reverse).
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
