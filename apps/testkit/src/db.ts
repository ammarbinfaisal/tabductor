import { randomUUID } from "node:crypto";
import os from "node:os";
import pg from "pg";

const HOST = process.env.PGHOST ?? "localhost";
const PORT = Number(process.env.PGPORT ?? 5432);
const USER = process.env.PGUSER ?? os.userInfo().username;

const DEFAULT_TEMPLATE = "tabductor_template";

/**
 * Serializes CREATE/DROP against a template across processes (vitest workers). Derived
 * from the template name so unrelated templates never block — or clobber — each other.
 */
function templateLockKey(template: string): number {
  let hash = 0x7abd_0c70;
  for (const ch of template) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) | 0;
  return hash;
}

const readyTemplates = new Set<string>();

export type TestDb = { url: string; drop: () => Promise<void> };

function dbUrl(name: string): string {
  return `postgres://${encodeURIComponent(USER)}@${HOST}:${PORT}/${name}`;
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ host: HOST, port: PORT, user: USER, database: "postgres" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withTemplateLock<T>(
  client: pg.Client,
  template: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = templateLockKey(template);
  await client.query("SELECT pg_advisory_lock($1)", [key]);
  try {
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [key]);
  }
}

/**
 * (Re)creates the template database and runs `sqlApplier` against it (e.g. migrations).
 * Subsequent `createTestDb()` calls in this process clone the template.
 *
 * The advisory lock is held across the *whole* sequence — drop, create, and apply. Vitest
 * runs test files in separate processes, so a lock released before `sqlApplier` would let
 * another worker drop the template out from under a half-applied migration.
 */
export async function prepareTemplate(
  sqlApplier: (url: string) => Promise<void>,
  template: string = DEFAULT_TEMPLATE,
): Promise<void> {
  await withAdmin((client) =>
    withTemplateLock(client, template, async () => {
      await client.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${template}`);
      await sqlApplier(dbUrl(template));
    }),
  );
  readyTemplates.add(template);
}

/**
 * Creates a uniquely named database on local PG, cloned from `template` if this process
 * prepared it. Parallel-safe.
 */
export async function createTestDb(template: string = DEFAULT_TEMPLATE): Promise<TestDb> {
  const name = `tabductor_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await withAdmin(async (client) => {
    if (readyTemplates.has(template)) {
      await withTemplateLock(client, template, () =>
        client.query(`CREATE DATABASE ${name} TEMPLATE ${template}`),
      );
    } else {
      await client.query(`CREATE DATABASE ${name}`);
    }
  });
  return {
    url: dbUrl(name),
    drop: () => withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }),
  };
}
