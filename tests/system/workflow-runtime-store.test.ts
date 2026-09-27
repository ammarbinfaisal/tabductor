import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tasks, runs } from "@tabductor/db";
import { AllowAllGate } from "@tabductor/core";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { startRun, recordRunOutcome, recordProgress, recordCompletionError, type RunHandle } from "@tabductor/engine";
import { workflowStoreTools } from "../../packages/agent/src/workflow-store-tools.js";
import { createCaller } from "../../apps/web/src/server/router.js";
import { pythonFixture } from "../../packages/agent/src/python-test-support.js";
let db: MigratedTestDb;
beforeAll(async () => { db = await createMigratedTestDb(); });
afterAll(async () => { await db?.close(); });
it("creates additive tables, commits immediately, and deduplicates writes across runtime recovery", async () => {
  const api = createCaller({ db: db.db });
  const created = await api.workflow.createFromPrompt({ prompt: "Collect products" });
  const execution = await api.workflow.trigger({ workflowId: created.workflowId });
  const run = (await startRun(db.db, execution.runs[0]!.runId!, undefined))!;
  const [task] = await db.db.select().from(tasks).where(eq(tasks.id, created.versionId));
  const handle = { task: task!, run } as RunHandle;
  const tools = await workflowStoreTools({ db: db.db, pool: db.pool, handle, gate: new AllowAllGate() });
  const call = (name: string, args: unknown) => tools.find(tool => tool.name === `store.${name}`)!.execute(args);
  const definition = { table: "products", columns: { sku: { type: "text" }, price: { type: "numeric" } }, primaryKey: ["sku"] };
  expect(await call("define_table", definition)).toMatchObject({ ok: true });
  const write = { table: "products", row: { sku: "a", price: 12 }, idempotencyKey: "product-a" };
  expect(await call("insert", write)).toMatchObject({ ok: true, value: { committed: true } });
  expect(await call("query", { sql: "select sku, price from products" })).toMatchObject({ ok: true, value: { rows: [{ sku: "a", price: "12" }], truncated: false } });
  const recovered = await workflowStoreTools({ db: db.db, pool: db.pool, handle, gate: new AllowAllGate() });
  expect(await recovered.find(tool => tool.name === "store.insert")!.execute(write)).toMatchObject({ ok: true });
  expect(await call("insert", { ...write, row: { sku: "a", price: 99 } })).toMatchObject({ ok: false });
  expect(await call("define_table", { ...definition, columns: { note: { type: "text", nullable: true } } })).toMatchObject({ ok: true });
  expect(await call("define_table", { ...definition, columns: { price: { type: "text" } } })).toMatchObject({ ok: false });
  expect(await call("query", { sql: "select sku, note from products" })).toMatchObject({ ok: true, value: { rows: [{ sku: "a", note: null }] } });
  const python = pythonFixture().tool({ storeTools: tools });
  expect(await python.execute({ source: `workflow.store.define_table(table='products', columns={'note': {'type': 'text', 'nullable': True}}, primaryKey=['sku'])
workflow.store.upsert(table='products', row={'sku': 'b', 'price': 25}, idempotencyKey='product-b')
workflow.store.insert(table='products', row={'sku': 'c', 'price': 30}, idempotencyKey='product-c')
result = workflow.store.query(sql='select sku from products order by sku')
assert [row['sku'] for row in result['rows']] == ['a', 'b', 'c']
workflow.done(result=result)` })).toMatchObject({ ok: true, terminal: { outcome: "done" } });
  await db.db.update(runs).set({ status: "cancelled" }).where(eq(runs.id, run.id));
  await expect(call("insert", { ...write, idempotencyKey: "new" })).rejects.toThrow("ownership");
});

it("tracks multiple explicit record identities and preserves acknowledged outcomes", async () => {
  const api = createCaller({ db: db.db });
  const created = await api.workflow.createFromPrompt({ prompt: "Save the available products" });
  const execution = await api.workflow.trigger({ workflowId: created.workflowId });
  const run = (await startRun(db.db, execution.runs[0]!.runId!, undefined))!;
  const [task] = await db.db.select().from(tasks).where(eq(tasks.id, created.versionId));
  await expect(recordRunOutcome(db.db, run, task!, null, { status: "saved", reason: "Missing identity" })).rejects.toThrow("recordKey");
  for (const recordKey of ["a", "b"]) await recordRunOutcome(db.db, run, task!, null, { collection: "products", recordKey, status: "extracted", reason: "Read product" });
  await recordRunOutcome(db.db, run, task!, null, { collection: "products", recordKey: "a", status: "saved", reason: "Saved product" });
  expect(await recordCompletionError(db.db, run, task!)).toContain("b");
  // Recovery cannot downgrade an acknowledged save, and a second record is independent.
  await recordRunOutcome(db.db, run, task!, null, { collection: "products", recordKey: "a", status: "pending", reason: "Recovery resumed" });
  await recordRunOutcome(db.db, run, task!, null, { collection: "products", recordKey: "b", status: "skipped", reason: "Duplicate product" });
  expect(await recordCompletionError(db.db, run, task!)).toBeNull();
  expect(await recordProgress(db.db, run.executionId!)).toMatchObject({ total: 2, saved: 1, skipped: 1, reportedSaved: 1, verifiedSaved: 0 });
});
