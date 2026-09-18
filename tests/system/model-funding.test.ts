import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelCredentials, modelOperations } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { fileKeyWrapper } from "@tabductor/secrets";
import { appendCreditAdjustment, createModelResolver, expireCreditReservations, getCreditBalance, modelCreditUnits,
  parseModelRates, resolveAccountIdentity, saveModelCredential, setModelSelection, settleModelOperation, staticSchemaGenerator, type ModelRate } from "@tabductor/engine";
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
