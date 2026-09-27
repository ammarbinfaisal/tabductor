import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billingSettings, billingRates, modelCredentials, modelOperations, modelSelections } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { fileKeyWrapper } from "@tabductor/secrets";
import { appendCreditAdjustment, createModelResolver, expireCreditReservations, getCreditBalance, modelCreditUnits,
  getGraphAuthoringModel, createWorkflow, seedWorkflow, triggerTask, parseModelRates, resolveAccountIdentity, saveModelCredential, setModelSelection, settleModelOperation, staticSchemaGenerator, type ModelRate } from "@tabductor/engine";
import { eq } from "drizzle-orm";
import { createCaller } from "../../apps/web/src/server/router.js";

let db: MigratedTestDb;
let dir: string;
beforeAll(async () => { db = await createMigratedTestDb(); dir = await mkdtemp(join(tmpdir(), "model-funding-")); });
afterAll(async () => { await db?.close(); if (dir) await rm(dir, { recursive: true }); });
const rate: ModelRate = { provider: "openai", model: "fixture-model", version: "fixture-v1", input: 1000, cachedInput: 100, output: 2000, maxInputTokens: 1024, maxOutputTokens: 100 };
const wrapper = () => fileKeyWrapper(join(dir, "kek.json"));
const resolver = (rates = [rate]) => createModelResolver({ db: db.db, wrapper: wrapper(), rates, platformKeys: { openai: "platform-fixture" } });
const account = (subject: string) => resolveAccountIdentity(db.db, { provider: "fixture", subject });

it("defaults graph generation and repair calls to the platform model without an account selection", async () => {
  const a = await account("graph-default");
  await appendCreditAdjustment(db.db, { accountId: a, kind: "purchase", units: 100, idempotencyKey: "graph-default-topup" });
  expect(await getGraphAuthoringModel(db.db)).toEqual({ provider: "openai", model: "gpt-6-astra" });
  const models = resolver([{ ...rate, model: "gpt-6-astra" }]);
  const invoke = vi.fn(async (config) => {
    expect(config).toMatchObject({ provider: "openai", model: "gpt-6-astra", apiKey: "platform-fixture" });
    return { value: "draft", usage: { input: 100, output: 30 } };
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await models.execute({ accountId: a, purpose: "graph" }, { inputTokenBound: 100 }, invoke);
  }
  expect(invoke).toHaveBeenCalledTimes(2);
  const operations = await db.db.select().from(modelOperations).where(eq(modelOperations.accountId, a));
  expect(operations).toHaveLength(2);
  expect(operations.every(op => op.model === "gpt-6-astra" && op.funding === "platform" && op.status === "succeeded")).toBe(true);
});

it("uses admin graph overrides without changing workflow BYO execution", async () => {
  const a = await account("graph-override");
  const workflowId = await createWorkflow(db.db, { accountId: a, userId: "fixture", name: "Graph override" });
  const key = await saveModelCredential(db.db, wrapper(), { accountId: a, provider: "openai", label: "Runtime", apiKey: "runtime-fixture" });
  await setModelSelection(db.db, a, { funding: "byo", provider: "openai", model: "account-model", credentialId: key.id });
  await setModelSelection(db.db, a, { scope: workflowId, funding: "byo", provider: "openai", model: "workflow-model", credentialId: key.id });
  await appendCreditAdjustment(db.db, { accountId: a, kind: "purchase", units: 100, idempotencyKey: "graph-override-topup" });
  const models = createModelResolver({ db: db.db, wrapper: wrapper(), rates: [{ ...rate, provider: "anthropic", model: "admin-model" }], platformKeys: { anthropic: "admin-provider-key" } });
  await db.db.insert(billingSettings).values({ key: "graph_authoring_model", value: { provider: "anthropic", model: "admin-model" } });
  try {
    await models.execute({ accountId: a, workflowId, purpose: "graph" }, { inputTokenBound: 100 }, async config => {
      expect(config).toMatchObject({ provider: "anthropic", model: "admin-model", apiKey: "admin-provider-key" });
      return { value: "graph", usage: { input: 100, output: 30 } };
    });
    await models.execute({ accountId: a, workflowId, purpose: "runtime" }, { inputTokenBound: 100 }, async config => {
      expect(config).toMatchObject({ provider: "openai", model: "workflow-model", apiKey: "runtime-fixture" });
      return { value: "runtime", usage: { input: 100, output: 30 } };
    });
  } finally {
    await db.db.delete(billingSettings).where(eq(billingSettings.key, "graph_authoring_model"));
  }
});

it("never falls back from the graph model when rates or platform credentials are unavailable", async () => {
  const a = await account("graph-unavailable");
  const key = await saveModelCredential(db.db, wrapper(), { accountId: a, provider: "openai", label: "BYO", apiKey: "not-for-authoring" });
  await setModelSelection(db.db, a, { funding: "byo", provider: "openai", model: "other-model", credentialId: key.id });
  const invoke = vi.fn();
  await expect(resolver([]).execute({ accountId: a, purpose: "graph" }, { inputTokenBound: 100 }, invoke))
    .rejects.toMatchObject({ code: "model_rate_unknown", message: expect.stringContaining("gpt-6-astra") });
  const unavailable = createModelResolver({ db: db.db, wrapper: wrapper(), rates: [{ ...rate, model: "gpt-6-astra" }], platformKeys: {} });
  await expect(unavailable.execute({ accountId: a, purpose: "graph" }, { inputTokenBound: 100 }, invoke))
    .rejects.toMatchObject({ code: "model_platform_unavailable", message: expect.stringContaining("Graph authoring") });
  expect(invoke).not.toHaveBeenCalled();
  expect(await db.db.select().from(modelOperations).where(eq(modelOperations.accountId, a))).toHaveLength(0);
});

it("encrypts BYO credentials and never returns them through settings, even to their owner", async () => {
  const a = await account("model-a"), b = await account("model-b");
  const saved = await saveModelCredential(db.db, wrapper(), { accountId: a, provider: "openai", label: "Personal", apiKey: "private-provider-fixture" });
  expect(JSON.stringify(await db.db.select().from(modelCredentials))).not.toContain("private-provider-fixture");
  const settings = await createCaller({ db: db.db, accountId: a, schemaGenerator: staticSchemaGenerator({}) }).account.modelSettings();
  expect(settings.credentials).toEqual([expect.objectContaining({ id: saved.id, label: "Personal" })]);
  expect(JSON.stringify(settings)).not.toMatch(/envelope|ciphertext|private-provider-fixture/);
  await expect(setModelSelection(db.db, b, { funding: "byo", provider: "openai", model: "fixture-model", credentialId: saved.id })).rejects.toMatchObject({ code: "model_credential_missing" });
  await setModelSelection(db.db, a, { funding: "byo", provider: "openai", model: "fixture-model", credentialId: saved.id });
  const invoke = vi.fn(async (config) => { expect(config.apiKey).toBe("private-provider-fixture"); return { value: "ok", usage: { input: 100, output: 30 } }; });
  expect(await resolver().execute({ accountId: a, purpose: "schema" }, { operationId: "byo-call", inputTokenBound: 100 }, invoke)).toBe("ok");
  expect((await getCreditBalance(db.db, a)).totalUnits).toBe(0);
  const [op] = await db.db.select().from(modelOperations).where(eq(modelOperations.id, "byo-call"));
  expect(op).toMatchObject({ funding: "byo", chargedUnits: 0, status: "succeeded", purpose: "schema", inputTokens: 100 });
  await expect(resolver().execute({ accountId: a, purpose: "schema" }, { operationId: "byo-call", inputTokenBound: 100 }, invoke)).rejects.toMatchObject({ code: "model_operation_exists" });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("surfaces BYO failure without platform fallback, credential text, or platform debit", async () => {
  const a = await account("model-byo-failure");
  const key = await saveModelCredential(db.db, wrapper(), { accountId: a, provider: "openai", label: "Test", apiKey: "never-expose-this" });
  await setModelSelection(db.db, a, { funding: "byo", provider: "openai", model: "anything", credentialId: key.id });
  const invoke = vi.fn(async () => { throw new Error("provider echoed never-expose-this"); });
  await expect(resolver().execute({ accountId: a, purpose: "authoring" }, { operationId: "byo-failed", inputTokenBound: 10 }, invoke)).rejects.toMatchObject({ code: "model_operation_uncertain" });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect((await getCreditBalance(db.db, a)).totalUnits).toBe(0);
});

it("passes an OpenAI-compatible credential's API root to every BYO invocation", async () => {
  const a = await account("model-compatible");
  const key = await saveModelCredential(db.db, wrapper(), {
    accountId: a, provider: "openai-compatible", label: "Gateway", apiKey: "compatible-key", baseUrl: "https://gateway.example/v1",
  });
  await setModelSelection(db.db, a, { funding: "byo", provider: "openai-compatible", model: "gateway-model", credentialId: key.id });
  const invoke = vi.fn(async (config) => ({ value: config, usage: { input: 100, output: 30 } }));
  await expect(resolver().execute({ accountId: a, purpose: "runtime" }, { inputTokenBound: 100 }, invoke))
    .resolves.toMatchObject({ provider: "openai-compatible", model: "gateway-model", apiKey: "compatible-key", baseUrl: "https://gateway.example/v1" });
  await expect(setModelSelection(db.db, a, { funding: "platform", provider: "openai-compatible", model: "gateway-model" }))
    .rejects.toMatchObject({ name: "ZodError" });
});

it("replaces the model selection at the same scope", async () => {
  const a = await account("model-reselection");
  await setModelSelection(db.db, a, { funding: "platform", provider: "openai", model: "first-model" });
  await setModelSelection(db.db, a, { funding: "platform", provider: "openai", model: "second-model" });
  expect(await db.db.select().from(modelSelections).where(eq(modelSelections.accountId, a)))
    .toEqual([expect.objectContaining({ scope: "account", model: "second-model" })]);
});

it("reserves before calling, pins rates, settles exactly once, and excludes reasoning from double billing", async () => {
  const a = await account("model-paid");
  await appendCreditAdjustment(db.db, { accountId: a, kind: "purchase", units: 100, idempotencyKey: "model-paid-topup" });
  await setModelSelection(db.db, a, { funding: "platform", provider: "openai", model: rate.model });
  await resolver().execute({ accountId: a, purpose: "trace_compilation" }, { operationId: "paid-call", inputTokenBound: 100 }, async () => {
    expect((await getCreditBalance(db.db, a)).reservedUnits).toBe(2);
    return { value: "result", usage: { input: 100, cachedInput: 50, output: 50, reasoning: 25 } };
  });
  await settleModelOperation(db.db, a, "paid-call");
  expect(await getCreditBalance(db.db, a)).toEqual({ availableUnits: 99, reservedUnits: 0, totalUnits: 99 });
  expect(modelCreditUnits(rate, { input: 100, cachedInput: 50, output: 50, reasoning: 25 })).toBe(1);
  const [op] = await db.db.select().from(modelOperations).where(eq(modelOperations.id, "paid-call"));
  expect(op).toMatchObject({ rateVersion: "fixture-v1", cachedInputTokens: 50, reasoningTokens: 25 });
});

it("uses one-million-token model limits saved in database rates", async () => {
  const a = await account("model-database-limits"), model = "database-million-model";
  await appendCreditAdjustment(db.db, { accountId: a, kind: "purchase", units: 10, idempotencyKey: "model-database-limits-topup" });
  await setModelSelection(db.db, a, { funding: "platform", provider: "openai", model });
  await db.db.insert(billingRates).values([
    { id: "rate_database_limits_input", category: "model", provider: "openai", item: `${model}:input`, chargeMicros: 1, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
    { id: "rate_database_limits_output", category: "model", provider: "openai", item: `${model}:output`, chargeMicros: 1 },
  ]);
  const invoke = vi.fn(async (config) => ({ value: config.maxOutputTokens, usage: { input: 10, output: 10 } }));
  await expect(resolver([]).execute({ accountId: a, purpose: "runtime" }, { operationId: "database-limits-call", inputTokenBound: 900_000 }, invoke)).resolves.toBe(1_000_000);
  expect(parseModelRates(JSON.stringify([{ ...rate, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 }]))[0]).toMatchObject({ maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 });
});

it("blocks unknown rates and insufficient credits before any provider request", async () => {
  const a = await account("model-poor");
  await setModelSelection(db.db, a, { funding: "platform", provider: "openai", model: rate.model });
  const invoke = vi.fn();
  await expect(resolver([]).execute({ accountId: a, purpose: "runtime" }, { inputTokenBound: 10 }, invoke)).rejects.toMatchObject({ code: "model_rate_unknown" });
  await expect(resolver().execute({ accountId: a, purpose: "runtime" }, { inputTokenBound: 10 }, invoke)).rejects.toMatchObject({ code: "credit_insufficient" });
  expect(invoke).not.toHaveBeenCalled();
  expect(await db.db.select().from(modelOperations).where(eq(modelOperations.accountId, a))).toHaveLength(0);
});

it("does not expire uncertain paid operations and serializes duplicate admission", async () => {
  const a = await account("model-uncertain");
  await appendCreditAdjustment(db.db, { accountId: a, kind: "purchase", units: 10, idempotencyKey: "model-uncertain-topup" });
  await setModelSelection(db.db, a, { funding: "platform", provider: "openai", model: rate.model });
  const invoke = vi.fn(async () => { throw new Error("lost provider response"); });
  await Promise.allSettled(Array.from({ length: 8 }, () => resolver().execute({ accountId: a, purpose: "runtime" }, { operationId: "uncertain-call", inputTokenBound: 100 }, invoke)));
  expect(invoke).toHaveBeenCalledTimes(1);
  await expireCreditReservations(db.db, new Date(Date.now() + 86_400_000));
  expect(await getCreditBalance(db.db, a)).toMatchObject({ availableUnits: 8, reservedUnits: 2 });
  expect(() => parseModelRates(JSON.stringify([rate, rate]))).toThrow();
});


it("pins funding and credentials at trigger admission across setting changes and background compilation", async () => {
  const a = await account("model-pinned");
  const key = await saveModelCredential(db.db, wrapper(), { accountId: a, provider: "openai", label: "Original", apiKey: "pinned-byo-fixture" });
  await setModelSelection(db.db, a, { funding: "byo", provider: "openai", model: rate.model, credentialId: key.id });
  const workflowId = await createWorkflow(db.db, { accountId: a, userId: "fixture", name: "Pinned" });
  const wf = await seedWorkflow(db.db, { workflowId, tasks: { T: { kind: "decision" } } });
  const first = await triggerTask(db.db, { taskId: wf.taskIds.T! });
  await setModelSelection(db.db, a, { funding: "platform", provider: "openai", model: rate.model });
  await appendCreditAdjustment(db.db, { accountId: a, kind: "purchase", units: 100, idempotencyKey: "pinned-topup" });
  const invoke = vi.fn(async (config) => ({ value: config.apiKey, usage: { input: 100, output: 10 } }));
  for (const purpose of ["runtime", "recovery", "trace_compilation"] as const) {
    expect(await resolver().execute({ accountId: a, workflowId, runId: first.dispatched!.runId, purpose }, { inputTokenBound: 100 }, invoke)).toBe("pinned-byo-fixture");
  }
  expect((await getCreditBalance(db.db, a)).totalUnits).toBe(100);
  const second = await triggerTask(db.db, { taskId: wf.taskIds.T! });
  expect(await resolver().execute({ accountId: a, workflowId, runId: second.dispatched!.runId, purpose: "runtime" }, { inputTokenBound: 100 }, invoke)).toBe("platform-fixture");
  await db.db.update(modelCredentials).set({ revokedAt: new Date() }).where(eq(modelCredentials.id, key.id));
  await expect(resolver().execute({ accountId: a, workflowId, runId: first.dispatched!.runId, purpose: "recovery" }, { inputTokenBound: 100 }, invoke)).rejects.toMatchObject({ code: "model_credential_missing" });
  expect(invoke).toHaveBeenCalledTimes(4);
});

it("does not adopt a later model selection for an execution admitted without one", async () => {
  const a = await account("model-missing-at-admission");
  const workflowId = await createWorkflow(db.db, { accountId: a, userId: "fixture", name: "No source" });
  const wf = await seedWorkflow(db.db, { workflowId, tasks: { T: { kind: "decision" } } });
  const started = await triggerTask(db.db, { taskId: wf.taskIds.T! });
  await setModelSelection(db.db, a, { funding: "platform", provider: "openai", model: rate.model });
  const invoke = vi.fn();
  await expect(resolver().execute({ accountId: a, workflowId, runId: started.dispatched!.runId, purpose: "runtime" }, { inputTokenBound: 100 }, invoke)).rejects.toMatchObject({ code: "model_selection_missing" });
  expect(invoke).not.toHaveBeenCalled();
});
