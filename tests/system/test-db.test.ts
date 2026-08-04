import { expect, it } from "vitest";
import pg from "pg";
import { createTestDb, prepareTemplate, type TestDb } from "@tabductor/testkit";

function dbName(url: string): string {
  return new URL(url).pathname.slice(1);
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function assertDroppedCleanly(dbs: TestDb[]): Promise<void> {
  await Promise.all(dbs.map((db) => db.drop()));
  const adminUrl = dbs[0]!.url.replace(/[^/]+$/, "postgres");
  const rows = await withClient(adminUrl, async (c) => {
    const res = await c.query("SELECT datname FROM pg_database WHERE datname = ANY($1)", [
      dbs.map((db) => dbName(db.url)),
    ]);
    return res.rows;
  });
  expect(rows).toHaveLength(0);
}

it("creates two test DBs in parallel — distinct, usable, droppable", async () => {
  const [a, b] = await Promise.all([createTestDb(), createTestDb()]);
  expect(dbName(a.url)).not.toBe(dbName(b.url));

  for (const db of [a, b]) {
    await withClient(db.url, async (c) => {
      await c.query("CREATE TABLE things (id int PRIMARY KEY, name text NOT NULL)");
      await c.query("INSERT INTO things VALUES (1, 'one'), (2, 'two')");
      const res = await c.query("SELECT name FROM things WHERE id = 2");
      expect(res.rows[0]).toEqual({ name: "two" });
    });
  }

  await assertDroppedCleanly([a, b]);
});

it("clones from a prepared template", async () => {
  await prepareTemplate(async (url) => {
    await withClient(url, async (c) => {
      await c.query("CREATE TABLE seeded (k text PRIMARY KEY)");
      await c.query("INSERT INTO seeded VALUES ('from-template')");
    });
  });

  const [a, b] = await Promise.all([createTestDb(), createTestDb()]);
  for (const db of [a, b]) {
    const value = await withClient(db.url, async (c) => {
      const res = await c.query("SELECT k FROM seeded");
      return res.rows[0]?.k as string;
    });
    expect(value).toBe("from-template");
  }

  await assertDroppedCleanly([a, b]);
  // The template DB is left in place on purpose: prepareTemplate recreates it from
  // scratch on every call, and later subphases clone it from a global setup hook.
});
