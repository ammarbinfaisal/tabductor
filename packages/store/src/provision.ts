import type { Pool, PoolClient } from "pg";
import { wfIdsOf } from "./ids.js";

/**
 * Provisioning and DDL application — the migrator (§3.3, §6.2): **the sole DDL holder**
 * against `wfdata_*` (style constraint, grep-able: this file, and only this file, ever sends
 * `CREATE`/`ALTER`/`DROP` to a `wfdata_*` schema or its role pair). Everything here runs
 * through a raw `pg.Pool` rather than the Drizzle `Db` the rest of the codebase uses, on
 * purpose: DDL blocks here are genuinely multi-statement (several `CREATE TABLE`s, a whole
 * role-and-grant sequence), and Drizzle's node-postgres session always sends queries over the
 * extended protocol, which is single-statement by design (the same property `query.ts` relies
 * on for the read fence). A raw client's plain-string `query(text)` uses the *simple* protocol,
 * which is the only way to execute a checked-in multi-statement DDL block atomically without
 * splitting and resubmitting it by hand.
 *
 * `store_schemas`/`store_write_grants` — the *platform* rows recording what was provisioned —
 * are still written through Drizzle by the caller (`graph.ts`'s publish path); this module
 * only ever touches `wfdata_*` objects and the role pair, never a platform table.
 */

export type WfConnectionInfo = { schema: string; readerRole: string; writerRole: string };

async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

const qi = (name: string): string => `"${name}"`;

/**
 * Creates `wfdata_<id>`, the `wfd_<id>_r`/`_w` role pair, schema-scoped grants, and
 * `ALTER DEFAULT PRIVILEGES` so tables migrations add later stay granted without a second
 * pass (§3.3). Idempotent by construction (`IF NOT EXISTS` throughout) — safe to call again
 * for a workflow that was already provisioned, which the template-clone test-DB model
 * exercises constantly (every test provisions its own workflow into a freshly cloned
 * database; nothing here depends on being called exactly once cluster-wide).
 *
 * **Roles are cluster-global, schemas are per-database.** A role name derived from a
 * `workflowId` (`wfIdsOf`) is astronomically unlikely to collide with another workflow's
 * (`newId` is a v4 UUID under the hood), but the `CREATE ROLE ... IF NOT EXISTS`-equivalent
 * guard below means even a name that *did* already exist cluster-wide (say, a prior test run
 * that leaked one) does not fail provisioning — the grants that follow are scoped to *this*
 * database's `wfdata_<id>` schema regardless of which database first created the role, because
 * Postgres tracks schema/table privileges per-database even for a role that exists everywhere.
 */
export async function provision(pool: Pool, workflowId: string): Promise<WfConnectionInfo> {
  const ids = wfIdsOf(workflowId);
  await withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      // `CREATE ROLE` has no `IF NOT EXISTS`; the DO block is the standard idiom.
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ids.readerRole}') THEN
            CREATE ROLE ${qi(ids.readerRole)} NOLOGIN;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ids.writerRole}') THEN
            CREATE ROLE ${qi(ids.writerRole)} NOLOGIN;
          END IF;
        END $$;
      `);
      // `SET LOCAL ROLE` (query.ts's read path, write.ts's write path) only succeeds if the
      // *current* session role is a member of the role being switched to — this grant is
      // what makes that legal for whichever login role this pool authenticates as (§3.3:
      // "Granted to the engine's login role"), without this file ever needing to know that
      // role's name; `current_user` is exactly the role running this transaction.
      await client.query(`GRANT ${qi(ids.readerRole)}, ${qi(ids.writerRole)} TO CURRENT_USER`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${qi(ids.schema)}`);
      await client.query(`
        GRANT USAGE ON SCHEMA ${qi(ids.schema)} TO ${qi(ids.readerRole)}, ${qi(ids.writerRole)};
        GRANT SELECT ON ALL TABLES IN SCHEMA ${qi(ids.schema)} TO ${qi(ids.readerRole)};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${qi(ids.schema)} TO ${qi(ids.writerRole)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${qi(ids.schema)} GRANT SELECT ON TABLES TO ${qi(ids.readerRole)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${qi(ids.schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${qi(ids.writerRole)};
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${qi(ids.schema)}._meta (
          id boolean PRIMARY KEY DEFAULT true,
          schema_version int NOT NULL DEFAULT 0,
          CONSTRAINT _meta_singleton CHECK (id)
        );
        INSERT INTO ${qi(ids.schema)}._meta (id, schema_version) VALUES (true, 0) ON CONFLICT DO NOTHING;
      `);
      await client.query(`GRANT SELECT ON ${qi(ids.schema)}._meta TO ${qi(ids.readerRole)}, ${qi(ids.writerRole)}`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
  return ids;
}

/** `DROP OWNED` / `DROP ROLE` / `DROP SCHEMA ... CASCADE` (deliverable 1). `DROP OWNED BY`
 * must run before `DROP ROLE` — a role that still owns objects cannot be dropped, in this or
 * any other database sharing the cluster (`pg_shdepend` is cluster-wide). */
export async function deprovision(pool: Pool, workflowId: string): Promise<void> {
  const ids = wfIdsOf(workflowId);
  await withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${qi(ids.schema)} CASCADE`);
      for (const role of [ids.readerRole, ids.writerRole]) {
        await client.query(`
          DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
              EXECUTE 'DROP OWNED BY ${role}';
              EXECUTE 'DROP ROLE ${role}';
            END IF;
          END $$;
        `);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

/**
 * Deliverable 1's "applies cleanly to a scratch schema (rolled back)" — layer two of the DDL
 * gate, `checkDdlShape` (`ddl.ts`) being layer one. Runs the *whole* structurally-valid DDL
 * block against a throwaway schema, inside a transaction that always rolls back, so "does
 * Postgres actually accept this" is answered for real without ever touching `wfdata_*`. A
 * schema-qualified statement cannot escape into a real schema here even if `checkDdlShape`
 * somehow missed one — `search_path` is pinned to the scratch schema alone, so an unqualified
 * `CREATE TABLE` lands there and a qualified one fails outright (the target schema does not
 * exist in this transaction's search path, and DDL cannot reach outside search_path without
 * naming it — the one path `checkDdlShape` already rejects statically).
 */
export async function validateDdlApplies(pool: Pool, ddl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const scratch = `wfdata_scratch_${Math.random().toString(16).slice(2, 10)}`;
  return withClient(pool, async (client) => {
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${qi(scratch)}`);
      await client.query(`SET LOCAL search_path = ${qi(scratch)}`);
      await client.query(ddl);
      return { ok: true } as const;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) } as const;
    } finally {
      // Always rolled back — this call has no observable effect on the database beyond the
      // duration of the transaction, win or lose.
      await client.query("ROLLBACK").catch(() => undefined);
    }
  });
}

/** Reads `_meta.schema_version` without touching it — the `none`-diff case (`store-schema.ts`
 * in `packages/engine`), where a publish records a new `store_schemas` row but nothing about
 * the physical schema changed, so nothing should bump the counter that exists precisely to
 * mark physical change (§6.2). */
export async function currentSchemaVersion(pool: Pool, workflowId: string): Promise<number> {
  const ids = wfIdsOf(workflowId);
  return withClient(pool, async (client) => {
    const { rows } = await client.query<{ schema_version: number }>(
      `SELECT schema_version FROM ${qi(ids.schema)}._meta WHERE id = true`,
    );
    return rows[0]?.schema_version ?? 0;
  });
}

/**
 * Applies a classified `additive` (or the confirmed `destructive`) migration's SQL against
 * `wfdata_<id>`, bumps `_meta.schema_version`, in one transaction (§6.2). The caller
 * (`graph.ts`'s publish path) is responsible for the classification and the confirmation-flag
 * check — this function trusts the SQL it is given the same way `provision` trusts its own
 * literal blocks, because both are engine-authored, never LLM- or user-supplied text.
 */
export async function applyMigration(pool: Pool, workflowId: string, sql: string): Promise<number> {
  const ids = wfIdsOf(workflowId);
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL search_path = ${qi(ids.schema)}`);
      if (sql.trim().length > 0) await client.query(sql);
      const { rows } = await client.query<{ schema_version: number }>(
        `UPDATE ${qi(ids.schema)}._meta SET schema_version = schema_version + 1 WHERE id = true RETURNING schema_version`,
      );
      await client.query("COMMIT");
      return rows[0]?.schema_version ?? 0;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}
