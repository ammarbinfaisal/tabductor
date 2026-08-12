import { afterEach, describe, expect, it } from "vitest";
import { AppError, newId } from "@tabductor/core";
import { storeWriteGrants, tasks, workflowVersions, type Db } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflow, publishStoreSchema, STORE_MIGRATION_DESTRUCTIVE, STORE_SCHEMA_INVALID } from "@tabductor/engine";
import { checkStoreWriteGrant, deprovision, validateRow, wfIdsOf } from "@tabductor/store";
import { CANDIDATES_VISITED_SPEC, publishCandidatesVisitedStore } from "./store-support.js";

/**
 * `store.insert`/`store.upsert`'s write path (§3.4) and the migration classifier/applier
 * (§6.2) — row validation, write grants, and additive/destructive migration handling, all
 * exercised through `publishStoreSchema` (the real control-plane path) rather than
 * `packages/store`'s internals directly, except where the internals are exactly what a test
 * targets (`validateRow`, `checkStoreWriteGrant`).
 */

let handle: MigratedTestDb | undefined;
/** Workflows this file actually provisioned a store for (§ store-fence.test.ts's own note:
 * roles are cluster-global and a dropped test database does not drop them). */
let provisioned: string[] = [];

afterEach(async () => {
  if (handle) {
    for (const workflowId of provisioned) await deprovision(handle.pool, workflowId).catch(() => undefined);
  }
  provisioned = [];
  await handle?.close();
  handle = undefined;
});

async function bareTask(db: Db, workflowId: string): Promise<string> {
  // A task row with no publish — write-grant checks only need `tasks.id` to exist, and this
  // file's grant tests want a task that is *not* wired into a graph at all.
  const [version] = await db
    .insert(workflowVersions)
    .values({ id: newId("wfv"), workflowId, graphJson: {} })
    .returning();
  const [task] = await db
    .insert(tasks)
    .values({ id: newId("task"), workflowVersionId: version!.id, name: "T", kind: "asset", mode: "ai" })
    .returning();
  return task!.id;
}

describe("row validation (ajv against tables_spec_json)", () => {
  it("a row matching the spec validates", () => {
    const result = validateRow("visited", CANDIDATES_VISITED_SPEC.visited!, {
      tweet_id: "t1",
      url: "https://x.com/t1",
      visited_at: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);
  });

  it("a row missing a required field is rejected, loudly", () => {
    const result = validateRow("visited", CANDIDATES_VISITED_SPEC.visited!, { tweet_id: "t1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("visited");
  });

  it("a row with an extra field is rejected (additionalProperties: false)", () => {
    const result = validateRow("visited", CANDIDATES_VISITED_SPEC.visited!, {
      tweet_id: "t1",
      url: "https://x.com/t1",
      visited_at: new Date().toISOString(),
      extra: "nope",
    });
    expect(result.ok).toBe(false);
  });
});

describe("store_write_grants — the asset_write_grants pattern applied to tables", () => {
  it("zero grant rows means open (every table)", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "grants-open", userId: "user_test" });
    const taskId = await bareTask(handle.db, workflowId);
    expect(await checkStoreWriteGrant(handle.db, taskId, "visited")).toBe(true);
    expect(await checkStoreWriteGrant(handle.db, taskId, "anything")).toBe(true);
  });

  it("a task with a grant row is scoped to exactly those tables", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "grants-scoped", userId: "user_test" });
    const taskId = await bareTask(handle.db, workflowId);
    await handle.db.insert(storeWriteGrants).values({ taskId, tableName: "visited" });

    expect(await checkStoreWriteGrant(handle.db, taskId, "visited")).toBe(true);
    expect(await checkStoreWriteGrant(handle.db, taskId, "candidates")).toBe(false);
  });
});

describe("store schema artifact validation (§5 checks 4–5)", () => {
  it("DDL with no primary key is rejected", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "no-pk", userId: "user_test" });
    const err = await publishStoreSchema(handle.db, handle.pool, {
      workflowId,
      ddl: `CREATE TABLE nokey (a text NOT NULL);`,
      tablesSpec: { nokey: { primaryKey: [], schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } } },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(STORE_SCHEMA_INVALID);
  });

  it("a column type outside the allowlist is rejected", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "bad-type", userId: "user_test" });
    const err = await publishStoreSchema(handle.db, handle.pool, {
      workflowId,
      ddl: `CREATE TABLE t (id uuid PRIMARY KEY);`,
      tablesSpec: { t: { primaryKey: ["id"], schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(STORE_SCHEMA_INVALID);
  });

  it("a tables_spec_json that does not biject with the DDL is rejected", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "not-bijective", userId: "user_test" });
    const err = await publishStoreSchema(handle.db, handle.pool, {
      workflowId,
      ddl: `CREATE TABLE t (id text PRIMARY KEY, extra_col text NOT NULL);`,
      tablesSpec: { t: { primaryKey: ["id"], schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(STORE_SCHEMA_INVALID);
  });
});

describe("migration classification and application (§6.2)", () => {
  it("first publish is additive (creates tables) and bumps schema_version to 1", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "first-publish", userId: "user_test" });
    const result = await publishCandidatesVisitedStore(handle, workflowId);
    provisioned.push(workflowId);
    expect(result.migrationClass).toBe("additive");
    expect(result.version).toBe(1);
  });

  it("adding a nullable column is additive, auto-applies, and old readers still see their columns", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "additive-column", userId: "user_test" });
    const v1 = await publishCandidatesVisitedStore(handle, workflowId);
    provisioned.push(workflowId);
    expect(v1.migrationClass).toBe("additive");

    const v2 = await publishStoreSchema(handle.db, handle.pool, {
      workflowId,
      ddl: `
        CREATE TABLE candidates (tweet_id text PRIMARY KEY, url text NOT NULL, posted_at timestamptz NOT NULL);
        CREATE TABLE visited (tweet_id text PRIMARY KEY, url text NOT NULL, visited_at timestamptz NOT NULL, note_path text);
      `,
      tablesSpec: {
        candidates: {
          primaryKey: ["tweet_id"],
          schema: {
            type: "object",
            properties: { tweet_id: { type: "string" }, url: { type: "string" }, posted_at: { type: "string" } },
            required: ["tweet_id", "url", "posted_at"],
            additionalProperties: false,
          },
        },
        visited: {
          primaryKey: ["tweet_id"],
          schema: {
            type: "object",
            properties: {
              tweet_id: { type: "string" },
              url: { type: "string" },
              visited_at: { type: "string" },
              note_path: { type: ["string", "null"] },
            },
            required: ["tweet_id", "url", "visited_at"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(v2.migrationClass).toBe("additive");
    expect(v2.version).toBe(2);

    // A run "pinned to v1" reading only v1's columns still works — the new column is
    // invisible to a query that never names it, not a breaking change to the physical table.
    const ids = wfIdsOf(workflowId);
    const client = await handle.pool.connect();
    try {
      await client.query(`SELECT tweet_id, url, visited_at FROM "${ids.schema}".visited`);
    } finally {
      client.release();
    }
  });

  it("dropping a column is destructive, rejected without confirmation, applied with it", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "destructive-column", userId: "user_test" });
    await publishCandidatesVisitedStore(handle, workflowId);
    provisioned.push(workflowId);

    const narrowedDdl = `
      CREATE TABLE candidates (tweet_id text PRIMARY KEY, url text NOT NULL, posted_at timestamptz NOT NULL);
      CREATE TABLE visited (tweet_id text PRIMARY KEY, visited_at timestamptz NOT NULL);
    `;
    const narrowedSpec = {
      candidates: {
        primaryKey: ["tweet_id"],
        schema: {
          type: "object",
          properties: { tweet_id: { type: "string" }, url: { type: "string" }, posted_at: { type: "string" } },
          required: ["tweet_id", "url", "posted_at"],
          additionalProperties: false,
        },
      },
      visited: {
        primaryKey: ["tweet_id"],
        schema: {
          type: "object",
          properties: { tweet_id: { type: "string" }, visited_at: { type: "string" } },
          required: ["tweet_id", "visited_at"],
          additionalProperties: false,
        },
      },
    };

    const rejected = await publishStoreSchema(handle.db, handle.pool, {
      workflowId,
      ddl: narrowedDdl,
      tablesSpec: narrowedSpec,
    }).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(AppError);
    expect((rejected as AppError).code).toBe(STORE_MIGRATION_DESTRUCTIVE);
    const diff = (rejected as AppError).details as { changes?: string[] };
    expect(diff.changes?.some((c) => c.includes("url"))).toBe(true);

    const applied = await publishStoreSchema(handle.db, handle.pool, {
      workflowId,
      ddl: narrowedDdl,
      tablesSpec: narrowedSpec,
      confirmDestructive: true,
    });
    expect(applied.migrationClass).toBe("destructive");
    expect(applied.version).toBe(2);

    const ids = wfIdsOf(workflowId);
    const client = await handle.pool.connect();
    try {
      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'visited'`,
        [ids.schema],
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["tweet_id", "visited_at"]);
    } finally {
      client.release();
    }
  });

  it("republishing the identical schema classifies none and does not bump schema_version", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "no-op-republish", userId: "user_test" });
    const v1 = await publishCandidatesVisitedStore(handle, workflowId);
    provisioned.push(workflowId);
    const v2 = await publishCandidatesVisitedStore(handle, workflowId);
    expect(v2.migrationClass).toBe("none");
    expect(v2.version).toBe(v1.version);
  });
});
