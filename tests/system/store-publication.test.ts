import { afterEach, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { outbox, storeSchemas, workflowVersions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflow, finishRun, publishStoreSchema, settleWorkflowExecutions, startRun, triggerTask } from "@tabductor/engine";
import { graphSchema, publishVersion, staticSchemaGenerator, type GraphDraftArtifact } from "@tabductor/engine/testing";
import { deprovision, wfIdsOf } from "@tabductor/store";

let handle: MigratedTestDb;
let workflowId: string;
beforeEach(async () => {
  handle = await createMigratedTestDb();
  workflowId = await createWorkflow(handle.db, { name: "atomic publication", userId: "store-test" });
});
afterEach(async () => {
  if (handle) { await deprovision(handle.pool, workflowId); await handle.close(); }
});

const graph = graphSchema.parse({ tasks: [{ name: "Root", emits: ["item.ready"] }], events: [{ type: "item.ready", description: "An item" }] });
function store(table: string): NonNullable<GraphDraftArtifact["store"]> {
  return { description: "Items", ddl: `CREATE TABLE ${table} (id text PRIMARY KEY);`,
    tablesSpec: { [table]: { primaryKey: ["id"], schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } } },
    confirmDestructive: false, forceDestructive: false };
}
async function tables() {
  const result = await handle.pool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = $1 and table_name <> '_meta' order by table_name", [wfIdsOf(workflowId).schema],
  );
  return result.rows.map((row) => row.table_name);
}
function publish(input: NonNullable<GraphDraftArtifact["store"]>, schemaGenerator = staticSchemaGenerator()) {
  return publishVersion(handle.db, { workflowId, graph, authoring: {
    report: { checks: [], attempts: 1 }, proposedGrants: [], store: input,
  } }, { schemaGenerator, pool: handle.pool });
}

it("rolls back physical DDL and schema metadata when graph publication fails", async () => {
  await handle.db.execute(sql`create function reject_version() returns trigger language plpgsql as $$
    begin raise exception 'injected graph failure'; end $$`);
  await handle.db.execute(sql`create trigger reject_version before insert on workflow_versions for each row execute function reject_version()`);
  await expect(publish(store("items"))).rejects.toMatchObject({ cause: { message: "injected graph failure" } });
  expect(await tables()).toEqual([]);
  expect(await handle.db.select().from(storeSchemas)).toHaveLength(0);
  const result = await handle.pool.query(`select schema_version from "${wfIdsOf(workflowId).schema}"._meta`);
  expect(result.rows[0].schema_version).toBe(0);
});

it("rejects concurrent publication from the same base without applying the losing store", async () => {
  let arrivals = 0;
  let ready!: () => void;
  const barrier = new Promise<void>((resolve) => { ready = resolve; });
  const generator = { generate: async () => {
    if (++arrivals === 2) ready();
    await barrier;
    return { ok: true as const, schema: { type: "object" } };
  } };
  const results = await Promise.allSettled([publish(store("one"), generator), publish(store("two"), generator)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason.message).toContain("published elsewhere");
  expect(await tables()).toHaveLength(1);
  expect(await handle.db.select().from(storeSchemas)).toHaveLength(1);
  expect(await handle.db.select().from(workflowVersions)).toHaveLength(1);
});

it("holds incompatible migrations while an execution has undelivered descendants, even with force", async () => {
  const initial = store("items");
  initial.ddl = "CREATE TABLE items (id text PRIMARY KEY, note text);";
  initial.tablesSpec.items!.schema = { type: "object", properties: { id: { type: "string" }, note: { type: ["string", "null"] } }, required: ["id"], additionalProperties: false };
  const version = await publish(initial);
  const [task] = await handle.db.query.tasks.findMany({ where: (task) => eq(task.workflowVersionId, version.versionId) });
  const { dispatched } = await triggerTask(handle.db, { taskId: task!.id });
  const run = (await startRun(handle.db, dispatched!.runId, undefined))!;
  await finishRun(handle.db, { runId: run.id, taskId: run.taskId, status: "succeeded", leaseGeneration: run.leaseGeneration });
  const narrowed = { workflowId, ...store("items"), confirmDestructive: true, forceDestructive: true };
  await expect(publishStoreSchema(handle.db, handle.pool, narrowed)).rejects.toMatchObject({ code: "store_migration_busy" });
  await handle.db.update(outbox).set({ status: "dispatched" });
  await settleWorkflowExecutions(handle.db);
  expect((await publishStoreSchema(handle.db, handle.pool, narrowed)).migrationClass).toBe("destructive");
});
