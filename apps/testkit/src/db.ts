import { randomUUID } from "node:crypto";
import os from "node:os";
import pg from "pg";

const HOST = process.env.PGHOST ?? "localhost";
const PORT = Number(process.env.PGPORT ?? 5432);
const USER = process.env.PGUSER ?? os.userInfo().username;

const TEMPLATE_NAME = "tabductor_template";
// Serializes CREATE/DROP against the template DB across processes (vitest workers).
const TEMPLATE_LOCK_KEY = 0x7abd_0c70;

let templateReady = false;

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

async function withTemplateLock<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]);
  }
}

/**
 * (Re)creates the template database and runs `sqlApplier` against it (e.g. migrations).
 * Subsequent `createTestDb()` calls in this process clone the template.
 */
export async function prepareTemplate(sqlApplier: (url: string) => Promise<void>): Promise<void> {
  await withAdmin((client) =>
    withTemplateLock(client, async () => {
      await client.query(`DROP DATABASE IF EXISTS ${TEMPLATE_NAME} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${TEMPLATE_NAME}`);
    }),
  );
  await sqlApplier(dbUrl(TEMPLATE_NAME));
  templateReady = true;
}

/** Creates a uniquely named database on local PG. Parallel-safe. */
export async function createTestDb(): Promise<TestDb> {
  const name = `tabductor_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await withAdmin(async (client) => {
    if (templateReady) {
      await withTemplateLock(client, () =>
        client.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_NAME}`),
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
