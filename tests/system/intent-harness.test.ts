import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDispatcher } from "@tabductor/bus";
import { browserSessions, destinationContracts, destinationRecords, events, humanActionRequests, runs, workflowExecutions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createEngine, createWorkflow, graphSchema, publishVersion, readGraph, staticSchemaGenerator, triggerTask, recordProgress,
  createBrowserProfile, requestBrowserSession, acknowledgeBrowserPause, resumeBrowserAutomation, type Engine, type ExecutorRegistry } from "@tabductor/engine";
import { bindIntent } from "../../packages/engine/src/intent-contract.js";
import { readDestinationContract } from "../../packages/engine/src/destination-contracts.js";

let db: MigratedTestDb, engine: Engine | undefined, dispatcher: ReturnType<typeof createDispatcher> | undefined;
beforeEach(async () => { db = await createMigratedTestDb(); });
afterEach(async () => { await dispatcher?.stop(); await engine?.stop(); await db?.close(); dispatcher = undefined; engine = undefined; });
const url = "https://destination.test/database";
const original = `Fetch 100 posts, dedupe and save their body to ${url}`;
const destination = { url, contractField: "destination_contract_id", requiredFields: ["body"], identityField: "stable_identity", readyEvent: "destination.ready", setupTask: "setup" };
const mapping = { canonicalUrl: url, fields: [{ packetField: "stable_identity", label: "Name", location: "title" as const }, { packetField: "body", label: "Body", location: "property" as const }],
  identityField: "stable_identity", verificationFields: ["stable_identity", "body"], dedupe: "search-before-create" as const };
const recordSchema = { type: "object", properties: { stable_identity: { type: "string" }, body: { type: "string" }, url: { type: "string" }, destination_contract_id: { type: "string" }, likes: { type: ["integer", "null"] } }, required: ["stable_identity", "body", "url", "destination_contract_id", "likes"], additionalProperties: false };
function graph() {
  return graphSchema.parse({ automationPrompt: original, intent: bindIntent(original, { requirements: [{ id: "read", description: "Fetch posts", quote: "Fetch 100 posts", category: "source" }, { id: "save", description: "Save body", quote: `save their body to ${url}`, category: "destination" }], quantity: { target: 100, measure: "source-records", interpretation: "explicit-user-requirement" } }),
    tasks: [
      { name: "setup", logicalId: "setup", entry: true, kind: "browser", mode: "ai", emits: ["destination.ready"], limits: { harness: { version: 1, role: "prepare-destination", requirementIds: ["save"], destination } } },
      { name: "source", entry: false, kind: "browser", mode: "ai", consumes: ["destination.ready"], emits: ["record.ready"], limits: { harness: { version: 1, role: "source", requirementIds: ["read"], destination }, recordProcessing: { version: 1, eventType: "record.ready", identityField: "stable_identity", sourceUrlField: "url", contentFields: ["body"], nullableFields: ["likes"], canonicalUrlFields: ["url"] } } },
      { name: "writer", entry: false, kind: "browser", mode: "ai", consumes: ["record.ready"], limits: { harness: { version: 1, role: "write-record", requirementIds: ["save"], destination } } },
    ], events: [{ type: "destination.ready", description: "Destination contract reference" }, { type: "record.ready", description: "One normalized post with body and destination reference", record: { collection: "posts", key: "stable_identity", status: "pending" } }] });
}
async function start(executors: ExecutorRegistry) {
  dispatcher = createDispatcher(db); engine = createEngine({ db: db.db, dispatcher, executors, scheduler: false, watchdogIntervalMs: 20 });
  await engine.start(); await dispatcher.start();
}
async function settled(executionId: string) {
  await vi.waitFor(async () => {
    const [row] = await db.db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId));
    expect(row?.status).toBe("succeeded");
  }, { timeout: 6000 });
}

it("prepares once, carries the mapping, deduplicates before scheduling and skips verified identities across executions", async () => {
  const workflowId = await createWorkflow(db.db, { name: "Intent pipeline", userId: "local" });
  const published = await publishVersion(db.db, { workflowId, graph: graph() }, { schemaGenerator: staticSchemaGenerator({ "record.ready": recordSchema }) });
  expect((await readGraph(db.db, published.versionId)).intent).toEqual(graph().intent);
  let writes = 0, setup = 0;
  await start({ "browser:ai": { async execute(handle) {
    if (handle.task.name === "setup") {
      setup++;
      await handle.destination!.publish(mapping, { url, snapshotId: "observed-schema", observedLabels: ["Name", "Body"] });
    } else if (handle.task.name === "source") {
      expect((await handle.destination!.read()).fields).toEqual(mapping.fields);
      const packet = { body: "actual body", url: "https://source.test/post/42?utm_source=feed", likes: null };
      expect(await handle.emit("record.ready", packet)).not.toBeNull();
      expect(await handle.emit("record.ready", packet)).toBeNull();
    } else {
      writes++;
      const contract = await handle.destination!.read(), packet = handle.trigger!.packet as Record<string, unknown>;
      expect(packet.stable_identity).toBe("url:https://source.test/post/42");
      await expect(handle.destination!.read("other-execution-id")).rejects.toMatchObject({ code: "destination_reference_missing" });
      await handle.recordOutcome!({ status: "saved", reason: "Read committed row", verification: { snapshotId: "saved-row", url, recordKey: String(packet.stable_identity), destinationContractId: contract.id, committed: true, checkedAt: new Date().toISOString() } });
    }
    return { ok: true };
  } } });
  const first = await triggerTask(db.db, { taskId: published.taskIds.setup! });
  await settled(first.event.executionId!);
  expect(await recordProgress(db.db, first.event.executionId!)).toMatchObject({ saved: 1, total: 1 });
  const second = await triggerTask(db.db, { taskId: published.taskIds.setup! });
  await settled(second.event.executionId!);
  expect(await recordProgress(db.db, second.event.executionId!)).toMatchObject({ skipped: 1, saved: 0, total: 1 });
  expect(setup).toBe(2); expect(writes).toBe(1);
  expect(await db.db.select().from(destinationContracts)).toHaveLength(2);
  expect(await db.db.select().from(destinationRecords)).toHaveLength(1);
  expect(await db.db.select().from(events).where(eq(events.type, "record.ready"))).toHaveLength(2);
  // A real contract ID from another execution is still rejected.
  const records = await db.db.select().from(events).where(eq(events.type, "record.ready"));
  const allRuns = await db.db.select().from(runs);
  const writer = allRuns.find(r => r.executionId === second.event.executionId && r.triggerEventId === records[1]!.eventId)!;
  const { tasks } = await import("@tabductor/db");
  const [task] = await db.db.select().from(tasks).where(eq(tasks.id, writer.taskId));
  await expect(readDestinationContract(db.db, writer, task!, { ...records[1]!, packet: records[0]!.packet })).rejects.toMatchObject({ code: "destination_contract_stale" });
});

it("rejects missing destination preparation before any version is published", async () => {
  const workflowId = await createWorkflow(db.db, { name: "Broken graph", userId: "local" });
  const draft = graph(); draft.tasks = draft.tasks.filter(t => t.name !== "setup");
  await expect(publishVersion(db.db, { workflowId, graph: draft }, { schemaGenerator: staticSchemaGenerator() })).rejects.toThrow("destination_setup_missing");
});

it("does not report setup success without publishing a ready mapping", async () => {
  const workflowId = await createWorkflow(db.db, { name: "Incomplete setup", userId: "local" });
  const published = await publishVersion(db.db, { workflowId, graph: graph() }, { schemaGenerator: staticSchemaGenerator({ "record.ready": recordSchema }) });
  await start({ "browser:ai": { execute: async () => ({ ok: true }) } });
  const triggered = await triggerTask(db.db, { taskId: published.taskIds.setup! });
  await vi.waitFor(async () => {
    const [run] = await db.db.select().from(runs).where(eq(runs.executionId, triggered.event.executionId!));
    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("destination_readiness_missing") });
  });
  expect(await db.db.select().from(destinationContracts)).toHaveLength(0);
  expect(await db.db.select().from(events).where(eq(events.type, "destination.ready"))).toHaveLength(0);
});

it("fences concurrent writers for the same destination record without spending another browser call", async () => {
  const workflowId = await createWorkflow(db.db, { name: "Concurrent writers", userId: "local" });
  const published = await publishVersion(db.db, { workflowId, graph: graph() }, { schemaGenerator: staticSchemaGenerator({ "record.ready": recordSchema }) });
  let release!: () => void, writes = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await start({ "browser:ai": { async execute(handle) {
    if (handle.task.name === "setup") await handle.destination!.publish(mapping, { url, snapshotId: "schema", observedLabels: ["Name", "Body"] });
    else if (handle.task.name === "source") await handle.emit("record.ready", { body: "same record", url: "https://source.test/42", likes: null });
    else {
      writes++;
      await hold;
      const contract = await handle.destination!.read(), packet = handle.trigger!.packet as Record<string, unknown>;
      await handle.recordOutcome!({ status: "saved", reason: "Committed", verification: { snapshotId: "row", url, recordKey: String(packet.stable_identity), destinationContractId: contract.id, committed: true, checkedAt: new Date().toISOString() } });
    }
    return { ok: true };
  } } });
  try {
    const first = await triggerTask(db.db, { taskId: published.taskIds.setup! });
    await vi.waitFor(() => expect(writes).toBe(1));
    const second = await triggerTask(db.db, { taskId: published.taskIds.setup! });
    await vi.waitFor(async () => expect((await db.db.select().from(runs).where(eq(runs.executionId, second.event.executionId!))).some(r => r.error?.startsWith("destination_record_busy"))).toBe(true));
    expect(writes).toBe(1);
    release();
    await settled(first.event.executionId!); await settled(second.event.executionId!);
    expect(writes).toBe(1);
    expect(await recordProgress(db.db, second.event.executionId!)).toMatchObject({ skipped: 1, saved: 0 });
  } finally { release(); }
});

it("persists human suspension, keeps execution open across restart, and resumes the same trigger with a fresh fence", async () => {
  const workflowId = await createWorkflow(db.db, { name: "Login", userId: "local" });
  const published = await publishVersion(db.db, { workflowId, graph: graphSchema.parse({ tasks: [{ name: "login", kind: "browser", mode: "ai" }] }) }, { schemaGenerator: staticSchemaGenerator() });
  const profileId = await createBrowserProfile(db.db, { accountId: "acct_local", name: "Login test" });
  let calls = 0, sessionId = "", firstFence = 0;
  const executors: ExecutorRegistry = { "browser:ai": { async execute(handle) {
    calls++;
    if (calls > 1) { expect(handle.run.leaseGeneration).toBeGreaterThan(firstFence); return { ok: true }; }
    firstFence = handle.run.leaseGeneration;
    sessionId = await requestBrowserSession(db.db, { accountId: "acct_local", profileId, executionId: handle.run.executionId! });
    await db.db.update(browserSessions).set({ status: "ready" }).where(eq(browserSessions.id, sessionId));
    await handle.requestHumanAction!({ reason: "Complete login", resumeWhen: "The database is visible" });
    return { ok: false, suspended: true, error: "Waiting for human" };
  } } };
  await start(executors);
  const triggered = await triggerTask(db.db, { taskId: published.taskIds.login! });
  await vi.waitFor(async () => expect((await db.db.select().from(runs))[0]?.status).toBe("awaiting_human"));
  await dispatcher!.stop(); await engine!.stop();
  await start(executors);
  expect(calls).toBe(1);
  const [execution] = await db.db.select().from(workflowExecutions).where(eq(workflowExecutions.id, triggered.event.executionId!));
  expect(execution?.status).toBe("running");
  const [session] = await db.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
  expect(session?.takeoverExpiresAt).toBeNull();
  await acknowledgeBrowserPause(db.db, { sessionId, generation: session!.generation, inputOwnerGeneration: session!.inputOwnerGeneration });
  await resumeBrowserAutomation(db.db, { accountId: "acct_local", sessionId });
  await settled(triggered.event.executionId!);
  expect(calls).toBe(2);
  expect((await db.db.select().from(humanActionRequests))[0]?.status).toBe("resumed");
});
