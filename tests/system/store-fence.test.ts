import type { Meter } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflow } from "@tabductor/engine";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createMetrics, type Metrics } from "@tabductor/telemetry";
import { deprovision, executeAsReader, fenceQuery, provision, runStoreQuery, wfIdsOf } from "@tabductor/store";
import { publishCandidatesVisitedStore } from "./store-support.js";

/**
 * `store.query`'s read fence (graph-compilation-llm §3.5): the parse-gate corpus
 * (table-driven, extend-on-new-idea per the spec) and the DB-layer role fence, proven with
 * the parse gate deliberately bypassed (`executeAsReader`, `query.ts`'s own doc comment) —
 * "defense in depth" only means something if the second layer is driven directly, not just
 * behind the first.
 */

let handle: MigratedTestDb | undefined;
/** Every workflow this file provisioned a store for — `deprovision`d before the test DB
 * closes. Roles are cluster-global (`provision.ts`'s own doc comment); dropping the test
 * *database* never drops them, so this file has to or every run leaks two roles per
 * provisioned workflow into the shared Postgres instance forever. */
let provisioned: string[] = [];

afterEach(async () => {
  if (handle) {
    for (const workflowId of provisioned) await deprovision(handle.pool, workflowId).catch(() => undefined);
  }
  provisioned = [];
  await handle?.close();
  handle = undefined;
});

/**
 * A fake `Meter` recording only what this file asserts on — the "one sanctioned telemetry
 * assertion" (S5c precedent): this is a security counter, not application state. `Meter` is a
 * large third-party (`@opentelemetry/api`) interface with methods this file never calls
 * (`createGauge`, the observable-* family); one cast to the interface is the standard way to
 * hand-build a minimal double for an SDK surface this wide, the same shape a hand-rolled
 * `Meter` fake takes anywhere OTel's own testing docs show one.
 */
function fakeMeter(): { meter: Meter; rejections: Array<{ reason: string }> } {
  const rejections: Array<{ reason: string }> = [];
  const meter = {
    createCounter: (name: string) => ({
      add: (_value: number, attrs?: Record<string, unknown>) => {
        if (name === "store_sql_rejected_total" && attrs) rejections.push({ reason: String(attrs.reason) });
      },
    }),
    createHistogram: () => ({ record: () => {} }),
  } as unknown as Meter;
  return { meter, rejections };
}

describe("store.query parse gate — corpus", () => {
  const CASES: Array<{ name: string; sql: string; reason: string }> = [
    { name: "multi-statement", sql: "SELECT 1; SELECT 2", reason: "multi_statement" },
    { name: "UPDATE", sql: "UPDATE candidates SET url = 'x'", reason: "not_select" },
    { name: "DELETE", sql: "DELETE FROM candidates", reason: "not_select" },
    { name: "SELECT ... INTO", sql: "SELECT 1 INTO scratch", reason: "parse_error" },
    { name: "FOR UPDATE", sql: "SELECT * FROM candidates FOR UPDATE", reason: "locking_clause" },
    { name: "FOR SHARE via CTE", sql: "WITH x AS (SELECT * FROM candidates FOR SHARE) SELECT * FROM x", reason: "locking_clause" },
    { name: "WITH ... INSERT smuggled as a binding", sql: "WITH ins AS (INSERT INTO candidates (tweet_id) VALUES ('x') RETURNING tweet_id) SELECT * FROM ins", reason: "not_select" },
    { name: "not SQL at all", sql: "this is not sql", reason: "parse_error" },
  ];

  it.each(CASES)("$name → $reason", ({ sql, reason }) => {
    const result = fenceQuery(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("a plain SELECT and a CTE'd SELECT both pass", () => {
    expect(fenceQuery("SELECT 1").ok).toBe(true);
    expect(fenceQuery("WITH x AS (SELECT 1) SELECT * FROM x").ok).toBe(true);
    expect(fenceQuery("SELECT 1 UNION SELECT 2").ok).toBe(true);
  });

  it("every rejection increments store_sql_rejected_total{reason} — the sanctioned telemetry assertion", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "fence-corpus", userId: "user_test" });
    await publishCandidatesVisitedStore(handle, workflowId);
    provisioned.push(workflowId);
    const { meter, rejections } = fakeMeter();
    const metrics: Metrics = createMetrics(meter);

    for (const { sql, reason } of CASES) {
      await runStoreQuery(handle.pool, workflowId, sql, { metrics });
      expect(rejections.at(-1)).toEqual({ reason });
    }
    expect(rejections).toHaveLength(CASES.length);
  });
});

describe("store role fence — defense in depth (parse gate bypassed)", () => {
  it("a SELECT against another workflow's wfdata_* schema fails at the DB layer", async () => {
    handle = await createMigratedTestDb();
    const a = await createWorkflow(handle.db, { name: "workflow-a", userId: "user_test" });
    const b = await createWorkflow(handle.db, { name: "workflow-b", userId: "user_test" });
    await publishCandidatesVisitedStore(handle, a);
    await publishCandidatesVisitedStore(handle, b);
    provisioned.push(a, b);

    const bSchema = wfIdsOf(b).schema;
    // `executeAsReader` skips `fenceQuery` entirely — this SQL would pass the parse gate (it
    // is a plain SELECT) were it run through `runStoreQuery`; the point of this test is that
    // the *database* refuses it regardless, because A's reader role has no grant on B's schema.
    const result = await executeAsReader(handle.pool, a, `select * from "${bSchema}".visited`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("db_error");
      expect(result.error).toMatch(/permission denied/i);
    }
  });

  it("a SELECT against a platform table (runs) fails at the DB layer", async () => {
    handle = await createMigratedTestDb();
    const a = await createWorkflow(handle.db, { name: "workflow-runs-probe", userId: "user_test" });
    await publishCandidatesVisitedStore(handle, a);
    provisioned.push(a);

    // `search_path` is pinned to `wfdata_<a>, pg_catalog` — reaching `public.runs` needs an
    // explicit schema qualification, which this bypasses the parse gate to attempt.
    const result = await executeAsReader(handle.pool, a, `select * from public.runs`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("db_error");
      expect(result.error).toMatch(/permission denied/i);
    }
  });

  it("provision/deprovision is idempotent — safe under the template-clone test-DB model", async () => {
    handle = await createMigratedTestDb();
    const workflowId = await createWorkflow(handle.db, { name: "idempotent-provision", userId: "user_test" });
    await provision(handle.pool, workflowId);
    await provision(handle.pool, workflowId); // second call must not throw
    await deprovision(handle.pool, workflowId);
    await deprovision(handle.pool, workflowId); // second call must not throw either
  });
});
