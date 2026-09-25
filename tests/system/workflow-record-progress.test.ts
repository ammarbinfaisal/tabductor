import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDispatcher } from "@tabductor/bus";
import { events, runs, runRecordOutcomes, workflowExecutions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createEngine, createWorkflow, graphSchema, publishVersion, recordProgress, staticSchemaGenerator, triggerTask, type Engine, type ExecutorRegistry } from "@tabductor/engine";
import { createCaller } from "../../apps/web/src/server/router.js";

let db: MigratedTestDb;
let engine: Engine | undefined;
let dispatcher: ReturnType<typeof createDispatcher> | undefined;
beforeEach(async () => { db = await createMigratedTestDb(); });
afterEach(async () => { await dispatcher?.stop(); await engine?.stop(); await db?.close(); engine = undefined; dispatcher = undefined; });

const packetSchema = { type: "object", properties: { id: { type: "string" }, count: { type: ["integer", "null"] } }, required: ["id", "count"], additionalProperties: false };
async function fixture(executors: ExecutorRegistry) {
  const workflowId = await createWorkflow(db.db, { name: "Record outcomes", userId: "local" });
  const published = await publishVersion(db.db, { workflowId, graph: graphSchema.parse({
    tasks: [
      { name: "collect", mode: "ai", kind: "browser", emits: ["item.extracted"] },
      { name: "prepare", mode: "ai", kind: "decision", consumes: ["item.extracted"], emits: ["item.pending"] },
      { name: "save", mode: "ai", kind: "browser", consumes: ["item.pending"], emits: ["item.saved"] },
    ], events: ["extracted", "pending", "saved"].map(status => ({ type: `item.${status}`, description: "id string, count integer or null", record: { collection: "items", key: "id", status } })),
  }) }, { schemaGenerator: staticSchemaGenerator(Object.fromEntries(["extracted", "pending", "saved"].map(status => [`item.${status}`, packetSchema]))) });
  dispatcher = createDispatcher(db);
  engine = createEngine({ db: db.db, dispatcher, executors, scheduler: false, watchdogIntervalMs: 20 });
  await engine.start(); await dispatcher.start();
  const triggered = await triggerTask(db.db, { taskId: published.taskIds.collect! });
  return { workflowId, executionId: triggered.event.executionId! };
}

it("keeps unknown counts, rejects silent drops, and counts only verified saves", async () => {
  const f = await fixture({
    "browser:ai": { async execute(handle) {
      if (handle.task.name === "collect") {
        for (const id of ["saved", "duplicate", "unusable", "silent"]) await handle.emit("item.extracted", { id, count: null }, { dedupeKey: id });
      } else {
        const packet = handle.trigger!.packet as { id: string };
        await handle.recordOutcome!({ status: "saved", reason: "Observed record at destination", verification: {
          snapshotId: "snapshot-1", recordKey: packet.id, url: "https://destination.test/rows/saved", checkedAt: new Date().toISOString(),
        } });
        await handle.emit("item.saved", handle.trigger!.packet);
      }
      return { ok: true };
    } },
    "decision:ai": { async execute(handle) {
      const { id } = handle.trigger!.packet as { id: string };
      if (id === "duplicate") await handle.recordOutcome!({ status: "skipped", reason: "Already saved" });
      else if (id === "unusable") await handle.recordOutcome!({ status: "rejected", reason: "No usable content" });
      else if (id === "saved") await handle.emit("item.pending", handle.trigger!.packet);
      return { ok: true }; // "silent" must not be allowed to disappear.
    } },
  });
  await vi.waitFor(async () => {
    const [execution] = await db.db.select().from(workflowExecutions).where(eq(workflowExecutions.id, f.executionId));
    expect(execution?.status).toBe("failed");
  }, { timeout: 5000 });
  expect(await recordProgress(db.db, f.executionId)).toEqual({ tracked: true, total: 4, extracted: 0, prepared: 0, pending: 0, saved: 1, skipped: 1, rejected: 1, failed: 1,verifiedSaved:1,aiAssessedSaved:0,reportedSaved:0 });
  const failed = await db.db.select().from(runs).where(eq(runs.executionId, f.executionId));
  expect(failed.some(run => run.error?.startsWith("record_outcome_missing"))).toBe(true);
  const [saved] = await db.db.select().from(events).where(eq(events.type, "item.saved"));
  expect(saved?.packet).toEqual({ id: "saved", count: null });
  expect((await db.db.select().from(runRecordOutcomes)).map(row => row.status)).toEqual(expect.arrayContaining(["prepared", "saved", "skipped", "rejected", "failed"]));
  expect(await createCaller({ db: db.db, schemaGenerator: staticSchemaGenerator() }).workflow.status(f)).toMatchObject({ status: "failed", records: { saved: 1, total: 4 } });
});

it("refuses a saved event without an explicit record outcome even when browser tasks report success", async () => {
  const f = await fixture({
    "browser:ai": { async execute(handle) {
      if (handle.task.name === "collect") await handle.emit("item.extracted", { id: "unverified", count: null });
      else await handle.emit("item.saved", handle.trigger!.packet);
      return { ok: true };
    } },
    "decision:ai": { async execute(handle) { await handle.emit("item.pending", handle.trigger!.packet); return { ok: true }; } },
  });
  await vi.waitFor(async () => expect(await recordProgress(db.db, f.executionId)).toMatchObject({ failed: 1 }), { timeout: 5000 });
  expect(await recordProgress(db.db, f.executionId)).toMatchObject({ saved: 0, total: 1 });
  expect(await db.db.select().from(events).where(eq(events.type, "item.saved"))).toHaveLength(0);
});

it("rejects narrowing nullable records before publishing any version", async () => {
  const workflowId = await createWorkflow(db.db, { name: "Invalid schema", userId: "local" });
  await expect(publishVersion(db.db, { workflowId, graph: graphSchema.parse({
    tasks: [{ name: "prepare", kind: "decision", mode: "ai", consumes: ["in"], emits: ["out"] }],
    events: [{ type: "in", description: "nullable count" }, { type: "out", description: "count" }],
  }) }, { schemaGenerator: staticSchemaGenerator({ in: packetSchema, out: { ...packetSchema, properties: { ...packetSchema.properties, count: { type: "integer" } } } }) }))
    .rejects.toMatchObject({ code: "record_schema_narrowing" });
});

it("accepts reported saves without a verification tool and keeps them separate from historical proofs", async () => {
  const f = await fixture({
    "browser:ai": { async execute(handle) {
      if (handle.task.name === "collect") await handle.emit("item.extracted", { id: "reported", count: null });
      else {
        await handle.recordOutcome!({ status: "saved", reason: "Saved the requested record" });
        await handle.emit("item.saved", handle.trigger!.packet);
      }
      return { ok: true };
    } },
    "decision:ai": { async execute(handle) { await handle.emit("item.pending", handle.trigger!.packet); return { ok: true }; } },
  });
  await vi.waitFor(async () => expect(await recordProgress(db.db, f.executionId)).toMatchObject({ saved: 1 }), { timeout: 5000 });
  expect(await recordProgress(db.db, f.executionId)).toMatchObject({ saved: 1, verifiedSaved: 0, aiAssessedSaved: 0, reportedSaved: 1 });
  const [outcome] = await db.db.select().from(runRecordOutcomes).where(eq(runRecordOutcomes.status, "saved"));
  expect(outcome?.verificationJson).toBeNull();
});
