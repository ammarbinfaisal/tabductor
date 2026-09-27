import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { canonicalJson, type PolicyGate } from "@tabductor/core";
import { storeSchemas, workflowStoreOperations, workflowVersions, workflows, type Db } from "@tabductor/db";
import { assertRunLease, publishStoreSchema, type RunHandle } from "@tabductor/engine";
import { checkDdlShape, checkStoreWriteGrant, createStoreQueryTool, createWriteStager, flushStagedWrites, stageRowWrite, validateRow, type StoreTablesSpec, type DdlTable } from "@tabductor/store";
import { defineTool, type AgentTool } from "./tools.js";

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const column = z.object({ type: z.enum(["int", "bigint", "text", "bool", "timestamptz", "date", "numeric", "jsonb"]), nullable: z.boolean().default(false) });
const tableDefinition = z.object({ table: identifier, columns: z.record(identifier, column), primaryKey: z.array(identifier).min(1) });
const writeArgs = z.object({ table: identifier, row: z.record(z.unknown()), idempotencyKey: z.string().min(1).max(200) });
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function workflowStoreTools(deps: { db: Db; pool: Pool; handle: RunHandle; gate: PolicyGate }): Promise<AgentTool[]> {
  const { db, pool, handle, gate } = deps;
  const [version] = await db.select().from(workflowVersions).where(eq(workflowVersions.id, handle.task.workflowVersionId));
  if (!version || !handle.run.executionId) return [];
  const workflowId = version.workflowId;
  const executionId = handle.run.executionId;
  const latest = async (trx: Db) => (await trx.select().from(storeSchemas).where(eq(storeSchemas.workflowId, workflowId)).orderBy(desc(storeSchemas.version)).limit(1))[0];
  const policy = { gate, taskCtx: { taskId: handle.task.id, runId: handle.run.id } };
  const write = (upsert: boolean): AgentTool => defineTool({
    name: upsert ? "store.upsert" : "store.insert",
    description: "Save one validated row immediately. Reuse the same idempotencyKey for retries of this logical write; use a new key for different writes. Acknowledged writes survive recovery and are immediately queryable.",
    parameters: writeArgs,
    async execute(args) {
      return db.transaction(async trx => {
        await assertRunLease(trx, handle.run.id, handle.run.leaseGeneration);
        await trx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${executionId + ':' + args.idempotencyKey}, 0))`);
        const hash = createHash("sha256").update(canonicalJson({ upsert, table: args.table, row: args.row })).digest("hex");
        const [receipt] = await trx.select().from(workflowStoreOperations).where(and(eq(workflowStoreOperations.executionId, executionId), eq(workflowStoreOperations.operationKey, args.idempotencyKey)));
        if (receipt) return receipt.requestHash === hash ? { ok: true as const, value: receipt.resultJson } : { ok: false as const, error: "This idempotencyKey already identifies a different write" };
        const schema = await latest(trx);
        const spec = (schema?.tablesSpecJson as StoreTablesSpec | undefined)?.[args.table];
        if (!spec) return { ok: false as const, error: "Define this table with store.define_table first" };
        const checked = validateRow(args.table, spec, args.row);
        if (!checked.ok) return checked;
        if (!await checkStoreWriteGrant(trx, handle.task.id, args.table, policy)) return { ok: false as const, error: "Store write denied" };
        const stager = createWriteStager();
        stageRowWrite(stager, args.table, args.row, upsert ? spec.primaryKey : undefined);
        await flushStagedWrites(workflowId, stager.drain())(trx);
        const value = { committed: true, table: args.table, idempotencyKey: args.idempotencyKey };
        await trx.insert(workflowStoreOperations).values({ workflowId, executionId, operationKey: args.idempotencyKey, requestHash: hash, resultJson: value });
        return { ok: true as const, value };
      });
    },
  });
  return [createStoreQueryTool({ pool, workflowId }), write(false), write(true), defineTool({
    name: "store.define_table",
    description: "Create a workflow-local table or add nullable columns. Existing types and primary keys cannot change. Calling again with the same definition is safe. Use lowercase SQL identifiers.",
    parameters: tableDefinition,
    async execute(args) {
      return db.transaction(async trx => {
        await assertRunLease(trx, handle.run.id, handle.run.leaseGeneration);
        await trx.select({ id: workflows.id }).from(workflows).where(eq(workflows.id, workflowId)).for("update");
        if (!await checkStoreWriteGrant(trx, handle.task.id, args.table, policy)) return { ok: false as const, error: "Store definition denied" };
        const previous = await latest(trx);
        const shape = previous ? checkDdlShape(previous.ddl) : { ok: true as const, tables: new Map<string, DdlTable>() };
        if (!shape.ok) return { ok: false as const, error: "Stored schema is invalid" };
        const existing = shape.tables.get(args.table);
        if (existing && canonicalJson(existing.primaryKey) !== canonicalJson(args.primaryKey)) return { ok: false as const, error: "Primary keys cannot change at runtime" };
        if (args.primaryKey.some(key => !args.columns[key] && !existing?.columns.has(key))) return { ok: false as const, error: "Every primary key needs a column definition" };
        const columns = new Map(existing?.columns ?? []);
        for (const [name, spec] of Object.entries(args.columns)) {
          const old = columns.get(name);
          if (old && (old.type !== spec.type || old.nullable !== spec.nullable)) return { ok: false as const, error: `Column ${name} cannot change at runtime` };
          if (!old && existing && !spec.nullable) return { ok: false as const, error: "New columns on existing tables must be nullable" };
          if (args.primaryKey.includes(name) && spec.nullable) return { ok: false as const, error: "Primary key columns cannot be nullable" };
          columns.set(name, { ...spec, hasDefault: false });
        }
        shape.tables.set(args.table, { columns, primaryKey: args.primaryKey });
        // Retain existing DDL verbatim, including defaults, and replace only the changed table.
        const specs: StoreTablesSpec = { ...(previous?.tablesSpecJson as StoreTablesSpec ?? {}) };
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        for (const [name, spec] of columns) {
          const type = spec.type === "bool" ? "boolean" : ["int", "bigint"].includes(spec.type) ? "integer" : spec.type === "numeric" ? "number" : spec.type === "jsonb" ? undefined : "string";
          properties[name] = type ? { type: spec.nullable ? [type, "null"] : type } : {};
          if (!spec.nullable && !spec.hasDefault) required.push(name);
        }
        specs[args.table] = { primaryKey: args.primaryKey, schema: { type: "object", properties, required, additionalProperties: false } };
        if ([...shape.tables.values()].some(table => [...table.columns.values()].some(col => col.hasDefault))) return { ok: false as const, error: "Tables with defaults require an administrator schema update" };
        const ddl = [...shape.tables].map(([name, table]) => `CREATE TABLE ${quote(name)} (${[...table.columns].map(([key, spec]) => `${quote(key)} ${spec.type}${spec.nullable ? '' : ' NOT NULL'}`).join(', ')}, PRIMARY KEY (${table.primaryKey.map(quote).join(', ')}));`).join('\n');
        const result = await publishStoreSchema(trx, pool, { workflowId, ddl, tablesSpec: specs });
        return { ok: true as const, value: { table: args.table, ...result } };
      });
    },
  })];
}
