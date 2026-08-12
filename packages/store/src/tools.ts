import type { Pool } from "pg";
import type { Metrics } from "@tabductor/telemetry";
import type { Db } from "@tabductor/db";
import { z } from "zod";
import type { StoreTablesSpec } from "./ddl.js";
import { runStoreQuery } from "./query.js";
import { checkStoreWriteGrant, createWriteStager, stageRowWrite, validateRow, type PendingWrite } from "./write.js";

/**
 * `store.query`/`store.insert`/`store.upsert` as tools — deliberately typed *structurally*
 * like `packages/agent`'s `AgentTool` rather than importing it: `packages/agent` already
 * depends on `@tabductor/store` (`decision-tools.ts`, `asset-executor.ts`), so the reverse
 * import would be a package cycle. `asset-tools.ts`'s own `assetToolToAgentTool` establishes
 * the precedent — a structurally-identical shape wrapped one field at a time at the one call
 * site that needs the real type, never a shared base type two packages both import.
 */
export type StoreToolResult = { ok: true; value: unknown } | { ok: false; error: string };
export type StoreTool = {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: unknown) => Promise<StoreToolResult>;
};

function defineTool<S extends z.ZodTypeAny>(spec: {
  name: string;
  description: string;
  parameters: S;
  execute: (args: z.infer<S>) => Promise<StoreToolResult>;
}): StoreTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    async execute(args) {
      const parsed = spec.parameters.safeParse(args);
      if (!parsed.success) return { ok: false, error: `invalid arguments for "${spec.name}": ${parsed.error.message}` };
      return spec.execute(parsed.data);
    },
  };
}

export type StoreQueryToolDeps = {
  pool: Pool;
  workflowId: string;
  metrics?: Metrics;
};

/** `kind=decision`'s *only* data tool, and `kind=asset`'s read-back tool (§2.3, §3.4). No
 * `tablesSpec` dependency at all — a `SELECT` is validated by the parse gate and the reader
 * role, never against the table spec, which exists to bound *writes*. */
export function createStoreQueryTool(deps: StoreQueryToolDeps): StoreTool {
  return defineTool({
    name: "store.query",
    description:
      "Run one read-only SQL SELECT against this workflow's data store. Single statement, CTEs " +
      "allowed, no locking clauses. Results are capped; a truncated result says so and how many " +
      "more rows exist — refine the query rather than assuming completeness.",
    parameters: z.object({ sql: z.string().min(1) }),
    async execute({ sql }) {
      const result = await runStoreQuery(deps.pool, deps.workflowId, sql, { metrics: deps.metrics });
      if (!result.ok) return { ok: false, error: `[${result.reason}] ${result.error}` };
      return {
        ok: true,
        value: {
          rows: result.rows,
          truncated: result.truncated,
          ...(result.truncated ? { note: `showing ${result.rows.length} rows; more exist — refine the query` } : {}),
        },
      };
    },
  });
}

export type StoreWriteToolDeps = {
  db: Db;
  workflowId: string;
  taskId: string;
  tablesSpec: StoreTablesSpec;
  /** Where a validated write lands instead of executing immediately — see `write.ts`'s own
   * doc comment on `createWriteStager` for why a tool call is not a commit point. */
  stager: ReturnType<typeof createWriteStager>;
};

function rowArg() {
  return z.record(z.string(), z.unknown());
}

async function checkedStage(
  deps: StoreWriteToolDeps,
  table: string,
  row: Record<string, unknown>,
  conflictKey: string[] | undefined,
): Promise<StoreToolResult> {
  const spec = deps.tablesSpec[table];
  if (!spec) return { ok: false, error: `no table "${table}" in this workflow's store schema` };

  const validated = validateRow(table, spec, row);
  if (!validated.ok) return { ok: false, error: validated.error };

  const granted = await checkStoreWriteGrant(deps.db, deps.taskId, table);
  if (!granted) return { ok: false, error: `this task has no store_write_grants entry for table "${table}"` };

  stageRowWrite(deps.stager, table, row, conflictKey);
  return { ok: true, value: { staged: true, table, commitsWith: "the run's next emit (or run completion)" } };
}

/** `kind=asset` only (§3.4) — plain insert, no conflict handling; a duplicate primary key
 * fails loudly (a tool error the agent can see and correct), matching "fails loudly on
 * mismatch" for the validation half. */
export function createStoreInsertTool(deps: StoreWriteToolDeps): StoreTool {
  return defineTool({
    name: "store.insert",
    description:
      "Insert one row into a table this workflow's store declares. Validated against the " +
      "table's schema before it is queued; fails on a duplicate primary key (use store.upsert " +
      "to overwrite). The write commits atomically with this run's next `emit` call.",
    parameters: z.object({ table: z.string().min(1), row: rowArg() }),
    async execute({ table, row }) {
      return checkedStage(deps, table, row, undefined);
    },
  });
}

/** `kind=asset` only (§3.4) — conflict target is the table's declared primary key, per the
 * spec's own `primaryKey`, not re-derived or trusted from the caller's `row`. */
export function createStoreUpsertTool(deps: StoreWriteToolDeps): StoreTool {
  return defineTool({
    name: "store.upsert",
    description:
      "Insert or update one row into a table this workflow's store declares, keyed by the " +
      "table's declared primary key. The write commits atomically with this run's next `emit` call.",
    parameters: z.object({ table: z.string().min(1), row: rowArg() }),
    async execute({ table, row }) {
      const spec = deps.tablesSpec[table];
      if (!spec) return { ok: false, error: `no table "${table}" in this workflow's store schema` };
      return checkedStage(deps, table, row, spec.primaryKey);
    },
  });
}

export type { PendingWrite };
