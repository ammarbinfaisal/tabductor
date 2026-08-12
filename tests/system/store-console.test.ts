import { afterEach, describe, expect, it } from "vitest";
import { createWorkflow, staticSchemaGenerator } from "@tabductor/engine";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { currentSchemaVersion, deprovision, wfIdsOf } from "@tabductor/store";
import { TRPCError } from "@trpc/server";
import { createCaller } from "../../apps/web/src/server/router.js";
import { CANDIDATES_VISITED_DDL, CANDIDATES_VISITED_SPEC, publishCandidatesVisitedStore } from "./store-support.js";

/**
 * U3.5's backend: the store browser + query console + schema-diff preview
 * (`apps/web/src/server/routers/store.ts`), driven through `createCaller` — the same entry
 * point the UI uses (impl-phases, UI-track rule 1). Not S5g's own test file (do not edit
 * those); this one proves the *router* is not a second, weaker gate in front of S5g's fence.
 *
 * `store.query`'s rejection corpus deliberately overlaps `store-fence.test.ts`'s: the console
 * has to reject the *same* things, for the *same* reasons, because it calls the exact same
 * `runStoreQuery` — this file is the proof that holds from the API boundary a client actually
 * reaches, not just from the package's own internals.
 */

let handle: MigratedTestDb | undefined;
/** Every workflow this file provisioned a store for — `deprovision`d before the test DB
 * closes (S5g's own lesson: roles are cluster-global, a dropped test database never drops
 * them). */
let provisioned: string[] = [];

afterEach(async () => {
  if (handle) {
    for (const workflowId of provisioned) await deprovision(handle.pool, workflowId).catch(() => undefined);
  }
  provisioned = [];
  await handle?.close();
  handle = undefined;
});

async function setup(): Promise<{ handle: MigratedTestDb; api: ReturnType<typeof createCaller> }> {
  handle = await createMigratedTestDb();
  const api = createCaller({ db: handle.db, pool: handle.pool, schemaGenerator: staticSchemaGenerator({}) });
  return { handle, api };
}

/** The error tRPC actually threw, so a test can assert on its code (`web-api.test.ts`'s own
 * helper, restated — that file is S2c's, not this slice's to import from). */
async function trpcError(fn: () => Promise<unknown>): Promise<TRPCError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TRPCError) return err;
    throw err;
  }
  throw new Error("expected the procedure to reject");
}

describe("store.query — the console IS the fence, not a second one", () => {
  const REJECTIONS: Array<{ name: string; sql: string; reason: string }> = [
    { name: "multi-statement", sql: "SELECT 1; SELECT 2", reason: "multi_statement" },
    { name: "UPDATE", sql: "UPDATE candidates SET url = 'x'", reason: "not_select" },
    { name: "DELETE", sql: "DELETE FROM candidates", reason: "not_select" },
    { name: "DDL (CREATE TABLE)", sql: "CREATE TABLE x (id int)", reason: "not_select" },
    { name: "SELECT ... INTO", sql: "SELECT 1 INTO scratch", reason: "parse_error" },
    { name: "FOR UPDATE", sql: "SELECT * FROM candidates FOR UPDATE", reason: "locking_clause" },
  ];

  it.each(REJECTIONS)(
    "$name → $reason — exactly the reason store.query's own fence rejects it with",
    async ({ sql, reason }) => {
      const { handle: h, api } = await setup();
      const workflowId = await createWorkflow(h.db, { name: "console-fence", userId: "user_test" });
      await publishCandidatesVisitedStore(h, workflowId);
      provisioned.push(workflowId);

      const result = await api.store.query({ workflowId, sql });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    },
  );

  it("a query against a table that doesn't exist fails at the DB layer, not the parse gate", async () => {
    const { handle: h, api } = await setup();
    const workflowId = await createWorkflow(h.db, { name: "console-missing-table", userId: "user_test" });
    await publishCandidatesVisitedStore(h, workflowId);
    provisioned.push(workflowId);

    const result = await api.store.query({ workflowId, sql: "select * from does_not_exist" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("db_error");
      expect(result.error).toMatch(/does not exist/i);
    }
  });

  it("a plain SELECT succeeds and returns rows delimited as data", async () => {
    const { handle: h, api } = await setup();
    const workflowId = await createWorkflow(h.db, { name: "console-plain-select", userId: "user_test" });
    await publishCandidatesVisitedStore(h, workflowId);
    provisioned.push(workflowId);

    const result = await api.store.query({ workflowId, sql: "select 1 as n" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toEqual([{ n: 1 }]);
  });

  it("an oversized result is capped by the fence's own row cap — no client-supplied limit widens it", async () => {
    const { handle: h, api } = await setup();
    const workflowId = await createWorkflow(h.db, { name: "console-row-cap", userId: "user_test" });
    await publishCandidatesVisitedStore(h, workflowId);
    provisioned.push(workflowId);
    const ids = wfIdsOf(workflowId);

    // 501 rows — one past `runStoreQuery`'s default cap (500) — inserted directly (this file
    // seeds data, it doesn't exercise the write fence; that's `store-write.test.ts`'s job).
    // The console's own input has no `limit`/`rowCap` field at all — there is nothing for a
    // hostile caller to widen, which this asserts by *not* providing one and still hitting
    // the cap on a query that itself asks for everything.
    await h.pool.query(
      `insert into "${ids.schema}".visited (tweet_id, url, visited_at)
       select 't' || g, 'https://x.com/' || g, now() from generate_series(1, 501) g`,
    );

    const result = await api.store.query({ workflowId, sql: "select * from visited" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.rows).toHaveLength(500);
      expect(result.totalFetched).toBe(501);
    }
  });

  it("an unknown workflow is a typed NOT_FOUND, not a fence rejection", async () => {
    const { api } = await setup();
    const err = await trpcError(() => api.store.query({ workflowId: "wf_does_not_exist", sql: "select 1" }));
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("store.overview — tables, row counts, schema version", () => {
  it("reports the current schema version and per-table row counts, live", async () => {
    const { handle: h, api } = await setup();
    const workflowId = await createWorkflow(h.db, { name: "overview", userId: "user_test" });
    const published = await publishCandidatesVisitedStore(h, workflowId);
    provisioned.push(workflowId);
    const ids = wfIdsOf(workflowId);

    await h.pool.query(
      `insert into "${ids.schema}".visited (tweet_id, url, visited_at) values ($1, $2, now())`,
      ["t1", "https://x.com/t1"],
    );

    const overview = await api.store.overview({ workflowId });
    expect(overview.schemaVersion).toBe(published.version);
    expect(overview.description).toContain("candidates awaiting a visit");

    const visited = overview.tables.find((t) => t.name === "visited");
    const candidates = overview.tables.find((t) => t.name === "candidates");
    expect(visited?.rowCount).toBe(1);
    expect(candidates?.rowCount).toBe(0);
    expect(visited?.primaryKey).toEqual(["tweet_id"]);
    expect([...(visited?.columns ?? [])].sort()).toEqual(["tweet_id", "url", "visited_at"]);
  });

  it("a workflow with no store schema published yet reports an empty overview, not an error", async () => {
    const { handle: h, api } = await setup();
    const workflowId = await createWorkflow(h.db, { name: "no-store-yet", userId: "user_test" });
    // Not provisioned, on purpose — nothing to `deprovision` either.

    const overview = await api.store.overview({ workflowId });
    expect(overview.schemaVersion).toBeNull();
    expect(overview.tables).toEqual([]);
  });

  it("an unknown workflow is a typed NOT_FOUND", async () => {
    const { api } = await setup();
    const err = await trpcError(() => api.store.overview({ workflowId: "wf_does_not_exist" }));
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("store.previewMigration — the classifier, without applying it", () => {
  it("classifies an additive change and leaves the physical schema_version untouched", async () => {
    const { handle: h, api } = await setup();
    const workflowId = await createWorkflow(h.db, { name: "preview-additive", userId: "user_test" });
    await publishCandidatesVisitedStore(h, workflowId);
    provisioned.push(workflowId);

    const before = await currentSchemaVersion(h.pool, workflowId);

    const additiveDdl = CANDIDATES_VISITED_DDL.replace(
      "visited_at timestamptz NOT NULL\n);",
      "visited_at timestamptz NOT NULL,\n  note text\n);",
    );
    const additiveSpec = {
      ...CANDIDATES_VISITED_SPEC,
      visited: {
        primaryKey: ["tweet_id"],
        schema: {
          type: "object",
          properties: {
            tweet_id: { type: "string" },
            url: { type: "string" },
            visited_at: { type: "string" },
            note: { type: "string" },
          },
          required: ["tweet_id", "url", "visited_at"],
          additionalProperties: false,
        },
      },
    };

    const diff = await api.store.previewMigration({ workflowId, ddl: additiveDdl, tablesSpec: additiveSpec });
    expect(diff.class).toBe("additive");
    expect(diff.changes).toContain('add column "visited"."note"');

    // Preview, not publish — nothing about the real store moved.
    expect(await currentSchemaVersion(h.pool, workflowId)).toBe(before);
  });

  it("classifies a destructive change (a dropped table) without requiring a confirm to preview it", async () => {
    const { handle: h, api } = await setup();
    const workflowId = await createWorkflow(h.db, { name: "preview-destructive", userId: "user_test" });
    await publishCandidatesVisitedStore(h, workflowId);
    provisioned.push(workflowId);

    const droppedDdl = `CREATE TABLE candidates (
      tweet_id text PRIMARY KEY,
      url text NOT NULL,
      posted_at timestamptz NOT NULL
    );`;
    const droppedSpec = { candidates: CANDIDATES_VISITED_SPEC.candidates! };

    const diff = await api.store.previewMigration({ workflowId, ddl: droppedDdl, tablesSpec: droppedSpec });
    expect(diff.class).toBe("destructive");
    expect(diff.changes).toContain('drop table "visited"');
  });

  it("an invalid DDL artifact is a typed rejection, not a 500", async () => {
    const { handle: h, api } = await setup();
    const workflowId = await createWorkflow(h.db, { name: "preview-invalid-ddl", userId: "user_test" });
    provisioned.push(workflowId);

    const err = await trpcError(() =>
      api.store.previewMigration({ workflowId, ddl: "this is not sql", tablesSpec: {} }),
    );
    expect(err.code).toBe("BAD_REQUEST");
  });
});
