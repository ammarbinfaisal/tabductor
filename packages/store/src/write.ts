import { Ajv, type ValidateFunction } from "ajv";
import { sql, eq } from "drizzle-orm";
import { storeWriteGrants, type Db } from "@tabductor/db";
import type { StoreTableSpec } from "./ddl.js";
import { wfIdsOf, type WorkflowStoreIds } from "./ids.js";

/**
 * `store.insert`/`store.upsert`'s write path (§3.4). Row validation reuses the same
 * "compile once by schema identity, ajv strict off at runtime" shape `packet-schema.ts` uses
 * for packets — not a second validator, an instance of the one pattern.
 */

const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new Map<string, ValidateFunction>();

export type RowCheck = { ok: true } | { ok: false; error: string };

export function validateRow(table: string, spec: StoreTableSpec, row: unknown): RowCheck {
  const cacheKey = `${table}:${JSON.stringify(spec.schema)}`;
  let validate = validatorCache.get(cacheKey);
  if (!validate) {
    validate = ajv.compile(spec.schema);
    validatorCache.set(cacheKey, validate);
  }
  if (validate(row)) return { ok: true };
  return { ok: false, error: `row failed schema for table "${table}": ${ajv.errorsText(validate.errors)}` };
}

/**
 * The exact `checkWriteGrant` (`packages/assets/src/grants.ts`) shape applied to
 * `store_write_grants` instead of `asset_write_grants`: zero rows for a task means open
 * (every table the workflow's store declares), at least one row scopes the task to exactly
 * those tables. Not a second design — the same "bounded blast radius, `AllowAllGate`-era
 * default" reasoning S5d already argued once.
 */
export async function checkStoreWriteGrant(db: Db, taskId: string, table: string): Promise<boolean> {
  const grants = await db.select({ table: storeWriteGrants.tableName }).from(storeWriteGrants).where(eq(storeWriteGrants.taskId, taskId));
  if (grants.length === 0) return true;
  return grants.some((g) => g.table === table);
}

/**
 * What `store.insert`/`store.upsert` actually queue instead of executing immediately — see
 * `executor-shared.ts`'s `makeEmitFn` extension for why: the canonical example (§7) needs the
 * store write and the triggering `emit` to commit in the *same* transaction, and a tool call
 * is not a transaction boundary. A stager is created once per run, `stage()`d by every
 * validated `store.insert`/`upsert` call, and `drain()`ed by the next `emit` (or, if the run
 * ends without one, by the executor's own final flush) — see `flushStagedWrites`.
 */
export type PendingWrite = (trx: Db) => Promise<void>;

export function createWriteStager(): { stage: (w: PendingWrite) => void; drain: () => PendingWrite[]; pending: () => number } {
  let queue: PendingWrite[] = [];
  return {
    stage: (w) => queue.push(w),
    drain: () => {
      const drained = queue;
      queue = [];
      return drained;
    },
    pending: () => queue.length,
  };
}

function quotedIdent(name: string) {
  return sql.identifier(name);
}

/** Builds the actual `INSERT`/`UPSERT` statement — parameterized (every value a bind param,
 * never string-concatenated into the text), the table/column names via `sql.identifier`
 * (escaped identifiers, never raw text) since they come from the workflow-authored spec, not
 * from this file's own vocabulary. */
function insertStatement(table: string, row: Record<string, unknown>, conflictKey: string[] | undefined) {
  const cols = Object.keys(row);
  const colList = sql.join(cols.map(quotedIdent), sql.raw(", "));
  const valList = sql.join(
    cols.map((c) => sql`${row[c]}`),
    sql.raw(", "),
  );
  const base = sql`insert into ${quotedIdent(table)} (${colList}) values (${valList})`;
  if (!conflictKey || conflictKey.length === 0) return base;

  const updateCols = cols.filter((c) => !conflictKey.includes(c));
  if (updateCols.length === 0) {
    return sql`${base} on conflict (${sql.join(conflictKey.map(quotedIdent), sql.raw(", "))}) do nothing`;
  }
  const setList = sql.join(
    updateCols.map((c) => sql`${quotedIdent(c)} = excluded.${quotedIdent(c)}`),
    sql.raw(", "),
  );
  return sql`${base} on conflict (${sql.join(conflictKey.map(quotedIdent), sql.raw(", "))}) do update set ${setList}`;
}

/** A staged write's actual execution, called only once its transaction has already switched
 * to the writer role and pinned `search_path` — `flushStagedWrites` does both around every
 * write this run staged, exactly once per commit. */
export function stageRowWrite(
  stager: ReturnType<typeof createWriteStager>,
  table: string,
  row: Record<string, unknown>,
  conflictKey: string[] | undefined,
): void {
  stager.stage(async (trx) => {
    await trx.execute(insertStatement(table, row, conflictKey));
  });
}

/**
 * The `emit`-side hook (`executor-shared.ts`'s `makeEmitFn` calls this as `RunHandle.emit`'s
 * `withTx`): switches to the writer role and this workflow's schema for exactly the staged
 * writes, then resets both — so the outer transaction's remaining work (`publish()`'s
 * `events`/`outbox` inserts) runs under the engine's own login role against the platform
 * schema, never the restricted writer role (§3.3: neither role has any privilege there).
 * A no-op (no `SET`/`RESET` at all) when nothing is staged, so a task that only ever emits
 * pays nothing for a capability it never used.
 */
export function flushStagedWrites(workflowId: string, writes: PendingWrite[]): (trx: Db) => Promise<void> {
  return async (trx) => {
    if (writes.length === 0) return;
    const ids = wfIdsOf(workflowId);
    await trx.execute(sql`SET LOCAL ROLE ${sql.identifier(ids.writerRole)}`);
    await trx.execute(sql`SET LOCAL search_path = ${sql.identifier(ids.schema)}, pg_catalog`);
    for (const write of writes) await write(trx);
    await trx.execute(sql`RESET ROLE`);
    await trx.execute(sql`SET LOCAL search_path TO DEFAULT`);
  };
}

export type { WorkflowStoreIds };
