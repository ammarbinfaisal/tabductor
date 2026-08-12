import type { Pool } from "pg";
import type { Metrics } from "@tabductor/telemetry";
import { fenceQuery, type FenceReason } from "./fence.js";
import { wfIdsOf } from "./ids.js";

/**
 * `store.query`'s execution path — read-fence layers (b) and (c) (graph-compilation-llm §3.5),
 * layer (a) being `fenceQuery` itself. Every query, rejected or not, is one call here so the
 * telemetry and the fence can never drift apart (§17.2's "a nonzero rate is a prompting bug or
 * an injection attempt" only holds if *every* rejection increments the counter, not just the
 * ones some call site remembered to check for).
 */

export type StoreQueryResult =
  | { ok: true; rows: Record<string, unknown>[]; truncated: boolean; totalFetched: number }
  | { ok: false; reason: FenceReason | "db_error"; error: string };

export type StoreQueryOptions = {
  /** Rows returned before truncation kicks in (§2.3: "first N rows plus a count"). */
  rowCap?: number;
  statementTimeoutMs?: number;
  metrics?: Metrics;
};

const DEFAULT_ROW_CAP = 500;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Layers (b)/(c) alone — reader role, `READ ONLY` transaction, pinned `search_path`, timeout,
 * row cap — with **no parse gate**. Not called by `runStoreQuery`'s normal path (which always
 * fences first); exported so the "defense in depth" system test can prove the DB-layer role
 * fence holds *even when the application-layer parse gate is bypassed entirely* — the point
 * of having two layers is that a bug or a bypass in one still meets the other, and that claim
 * is only provable by driving the second layer directly with something the first would have
 * rejected.
 */
export async function executeAsReader(
  pool: Pool,
  workflowId: string,
  sql: string,
  opts: StoreQueryOptions = {},
): Promise<StoreQueryResult> {
  const rowCap = opts.rowCap ?? DEFAULT_ROW_CAP;
  const timeoutMs = opts.statementTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const ids = wfIdsOf(workflowId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    try {
      // §3.3's per-statement fence: reader role, pinned search_path (workflow schema only —
      // never the platform tables, never another workflow's schema), a bounded timeout. Each
      // is its own `SET LOCAL`, scoped to this transaction and reset by the `ROLLBACK` below
      // regardless of how the query itself turns out.
      await client.query(`SET LOCAL ROLE "${ids.readerRole}"`);
      await client.query(`SET LOCAL search_path = "${ids.schema}", pg_catalog`);
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);

      // The cap: fetch N+1 by wrapping the author's single validated SELECT in an outer
      // `LIMIT` rather than appending one to the original text (which could land inside a
      // CTE or after the author's own `LIMIT`, changing the query's meaning). The wrapped
      // form is itself sent over the extended protocol (a `values` array, even empty, is
      // what selects it in node-postgres) — single-statement by protocol, independent of the
      // parse gate already passed.
      const inner = sql.trim().replace(/;\s*$/, "");
      const wrapped = `select * from (${inner}) as __fenced limit ${rowCap + 1}`;
      const result = await client.query({ text: wrapped, values: [] });
      const rows = result.rows as Record<string, unknown>[];
      const truncated = rows.length > rowCap;
      opts.metrics?.storeQueryDuration.record((Date.now() - started) / 1000, { outcome: "ok" });
      return { ok: true, rows: truncated ? rows.slice(0, rowCap) : rows, truncated, totalFetched: rows.length };
    } finally {
      // Read-only by the transaction mode above; rolling back (rather than committing) means
      // even a side-effectful function the parse gate missed leaves nothing behind.
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } catch (err) {
    opts.metrics?.storeQueryDuration.record((Date.now() - started) / 1000, { outcome: "error" });
    return { ok: false, reason: "db_error", error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.release();
  }
}

export async function runStoreQuery(
  pool: Pool,
  workflowId: string,
  sql: string,
  opts: StoreQueryOptions = {},
): Promise<StoreQueryResult> {
  const fenced = fenceQuery(sql);
  if (!fenced.ok) {
    opts.metrics?.storeSqlRejected.add({ reason: fenced.reason });
    return { ok: false, reason: fenced.reason, error: fenced.error };
  }
  return executeAsReader(pool, workflowId, sql, opts);
}
