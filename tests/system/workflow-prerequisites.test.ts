import { refreshWorkflowBlocks } from "../../packages/engine/src/prerequisites.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDispatcher } from "@tabductor/bus";
import { browserFleetStatus, cdpEndpoints, modelCredentials, modelSelections, runs, workflowExecutions, workflows } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { checkWorkflowPrerequisites, createEngine, createScheduler, createWorkflow, triggerTask, type Engine } from "@tabductor/engine";
import { graphSchema, publishVersion, staticSchemaGenerator } from "@tabductor/engine/testing";
import { createCaller } from "../../apps/web/src/server/router.js";

let db: MigratedTestDb;
let engine: Engine | undefined;
beforeEach(async () => { db = await createMigratedTestDb(); });
afterEach(async () => { await engine?.stop(); await db?.close(); engine = undefined; });
const prerequisites = { browserMode: "endpoints" as const, platformProviders: ["openai"], platformModels: [{ provider: "openai", model: "fixture" }] };
async function fixture(schedule = false) {
  const workflowId = await createWorkflow(db.db, { name: "Prerequisites", userId: "local" });
  const published = await publishVersion(db.db, { workflowId, graph: graphSchema.parse({ tasks: [{ name: "collect", mode: "ai", kind: "browser",
    ...(schedule ? { schedule: { cron: "* * * * * *", missedPolicy: "skip" } } : {}) }] }) }, { schemaGenerator: staticSchemaGenerator() });
  return { workflowId, taskId: published.taskIds.collect! };
}
async function selectPlatform() {
  await db.db.insert(modelSelections).values({ accountId: "acct_local", scope: "account", funding: "platform", provider: "openai", model: "fixture" });
}

it("keeps missing prerequisites blocked without starting or failing runs, then resumes when configured", async () => {
  const f = await fixture();
  const triggered = await triggerTask(db.db, { taskId: f.taskId });
  const execute = vi.fn(async () => ({ ok: true as const }));
  engine = createEngine({ db: db.db, dispatcher: createDispatcher(db), prerequisites, scheduler: false, watchdogIntervalMs: 20,
    executors: { "browser:ai": { execute } } });
  await engine.start();
  const api = createCaller({ db: db.db, schemaGenerator: staticSchemaGenerator() });
  await vi.waitFor(async () => expect(await api.workflow.status({ workflowId: f.workflowId, executionId: triggered.event.executionId! }))
    .toMatchObject({ status: "blocked", blocked: { code: "model_selection_missing" } }), { timeout: 5000 });
  expect(execute).not.toHaveBeenCalled();
  const [blocked] = await db.db.select().from(runs);
  expect(blocked).toMatchObject({ status: "queued", startedAt: null, deadlineAt: null, error: null });
  await expect(triggerTask(db.db, { taskId: f.taskId })).rejects.toMatchObject({ code: "workflow_blocked" });
  await selectPlatform();
  expect(await checkWorkflowPrerequisites(db.db, f.taskId, prerequisites)).toMatchObject({ code: "browser_unavailable" });
  await db.db.insert(cdpEndpoints).values({ id: "endpoint", workflowId: f.workflowId, wsUrl: "http://fixture", healthy: true });
  await db.db.update(runs).set({ notBefore: new Date(0) });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), { timeout: 5000 });
  expect((await db.db.select().from(workflowExecutions))[0]?.modelSelectionJson).toMatchObject({ provider: "openai", model: "fixture" });
  expect((await db.db.select().from(workflows).where(eq(workflows.id, f.workflowId)))[0]?.blockedReasonJson).toBeNull();
});

it("does not create executions on repeated scheduled fires while prerequisites are missing", async () => {
  const f = await fixture(true);
  let now = Date.now();
  const scheduler = createScheduler({ db: db.db, prerequisites, now: () => now });
  await scheduler.tick();
  for (let i = 0; i < 5; i++) { now += 1500; await scheduler.tick(); }
  expect(await db.db.select().from(runs)).toHaveLength(0);
  expect(await db.db.select().from(workflowExecutions)).toHaveLength(0);
  expect((await db.db.select().from(workflows).where(eq(workflows.id, f.workflowId)))[0]?.blockedReasonJson).toMatchObject({ code: "model_selection_missing" });
  await selectPlatform();
  await db.db.insert(cdpEndpoints).values({ id: "restored", workflowId: f.workflowId, wsUrl: "http://fixture", healthy: true });
  await refreshWorkflowBlocks(db.db, prerequisites);
  // No additional schedule tick is needed after configuration is repaired.
  await expect(triggerTask(db.db, { taskId: f.taskId })).resolves.toHaveProperty("dispatched");
});

it("checks credential revocation and platform configuration before any model call", async () => {
  const f = await fixture();
  await db.db.insert(modelCredentials).values({ id: "key", accountId: "acct_local", provider: "openai", label: "fixture",
    envelope: { ciphertext: "x", nonce: "x", wrapped: "x", kekRef: "x" }, revokedAt: new Date() });
  await db.db.insert(modelSelections).values({ accountId: "acct_local", scope: "account", funding: "byo", provider: "openai", model: "fixture", credentialId: "key" });
  expect(await checkWorkflowPrerequisites(db.db, f.taskId, prerequisites)).toMatchObject({ code: "model_credential_missing" });
  await db.db.update(modelSelections).set({ funding: "platform", credentialId: null });
  expect(await checkWorkflowPrerequisites(db.db, f.taskId, { ...prerequisites, platformProviders: [] })).toMatchObject({ code: "model_platform_unavailable" });
});

it("admits on-demand fleets without requiring an already-warm worker", async () => {
  const f = await fixture();
  await selectPlatform();
  const fleet = { ...prerequisites, browserMode: "fleet" as const };
  expect(await checkWorkflowPrerequisites(db.db, f.taskId, fleet)).toMatchObject({ code: "browser_unavailable" });
  await db.db.insert(browserFleetStatus).values({ id: "fleet", maxAllocated: 3 });
  expect(await checkWorkflowPrerequisites(db.db, f.taskId, fleet)).toBeNull();
  await db.db.update(browserFleetStatus).set({ heartbeatAt: new Date(0) });
  expect(await checkWorkflowPrerequisites(db.db, f.taskId, fleet)).toMatchObject({ code: "browser_unavailable" });
});
