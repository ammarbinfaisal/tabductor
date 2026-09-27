import { afterAll, beforeAll, expect, it } from "vitest";
import { creditLedgerEntries, creditReservations } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { appendCreditAdjustment, expireCreditReservations, getCreditBalance, releaseCreditReservation, reserveCredits, resolveAccountIdentity, settleCreditReservation } from "@tabductor/engine";
import { staticSchemaGenerator } from "@tabductor/engine/testing";
import { eq } from "drizzle-orm";
import { createCaller } from "../../apps/web/src/server/router.js";

let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });

const callerFor = (accountId: string) => createCaller({
  db: handle.db,
  pool: handle.pool,
  accountId,
  schemaGenerator: staticSchemaGenerator({}),
});

it("applies external credit movements exactly once and keeps account balances isolated", async () => {
  const a = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "credits_a" });
  const b = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "credits_b" });
  const input = {
    accountId: a,
    kind: "purchase" as const,
    units: 1_000,
    idempotencyKey: "paddle:transaction:txn_1:completed",
    metadata: { transactionId: "txn_1", priceId: "pri_1" },
  };

  const first = await appendCreditAdjustment(handle.db, input);
  const duplicate = await appendCreditAdjustment(handle.db, input);
  expect(duplicate.id).toBe(first.id);
  expect(await callerFor(a).account.walletBalance()).toEqual({
    currency: "USD", availableUsd: "0.001", reservedUsd: "0.00",
  });
  expect(await callerFor(b).account.walletBalance()).toEqual({
    currency: "USD", availableUsd: "0.00", reservedUsd: "0.00",
  });
  expect(await handle.db.select().from(creditLedgerEntries)
    .where(eq(creditLedgerEntries.idempotencyKey, input.idempotencyKey))).toHaveLength(1);

  await expect(appendCreditAdjustment(handle.db, { ...input, units: 2_000 }))
    .rejects.toMatchObject({ code: "credit_idempotency_conflict" });

  await expect(handle.db.update(creditLedgerEntries).set({ units: 999 })
    .where(eq(creditLedgerEntries.id, first.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining("append-only") }),
    });
  await expect(handle.db.delete(creditLedgerEntries)
    .where(eq(creditLedgerEntries.id, first.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining("append-only") }),
    });
});

it("atomically prevents concurrent operations from overspending one account", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "credits_race" });
  await appendCreditAdjustment(handle.db, {
    accountId,
    kind: "adjustment",
    units: 100,
    idempotencyKey: "fixture:credits_race:topup",
  });

  const attempts = await Promise.allSettled([
    reserveCredits(handle.db, { accountId, operationId: "model:one", category: "model", units: 80 }),
    reserveCredits(handle.db, { accountId, operationId: "model:two", category: "model", units: 80 }),
  ]);
  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  const failed = attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({ code: "credit_insufficient" });
  expect(await getCreditBalance(handle.db, accountId)).toEqual({
    availableUnits: 20,
    reservedUnits: 80,
    totalUnits: 100,
  });

  const reservation = (attempts.find((attempt) => attempt.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveCredits>>>).value;
  const settled = await settleCreditReservation(handle.db, {
    accountId,
    reservationId: reservation.id,
    actualUnits: 50,
  });
  expect(settled).toMatchObject({ status: "settled", settledUnits: 50 });
  expect(await getCreditBalance(handle.db, accountId)).toEqual({
    availableUnits: 50,
    reservedUnits: 0,
    totalUnits: 50,
  });

  await expect(settleCreditReservation(handle.db, {
    accountId,
    reservationId: reservation.id,
    actualUnits: 50,
  })).resolves.toMatchObject({ id: reservation.id, status: "settled" });
  await expect(settleCreditReservation(handle.db, {
    accountId,
    reservationId: reservation.id,
    actualUnits: 60,
  })).rejects.toMatchObject({ code: "credit_settlement_conflict" });
});

it("releases abandoned reservations and can carry debt after a refund", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "credits_expiry" });
  await appendCreditAdjustment(handle.db, {
    accountId,
    kind: "purchase",
    units: 60,
    idempotencyKey: "paddle:transaction:txn_expiry:completed",
  });
  const reservation = await reserveCredits(handle.db, {
    accountId,
    operationId: "browser:session_expiry",
    category: "browser",
    units: 40,
    ttlMs: 1_000,
  });

  expect(await expireCreditReservations(handle.db, new Date(Date.now() + 1_001))).toBe(1);
  expect(await getCreditBalance(handle.db, accountId)).toEqual({
    availableUnits: 60,
    reservedUnits: 0,
    totalUnits: 60,
  });
  const [expired] = await handle.db.select().from(creditReservations).where(eq(creditReservations.id, reservation.id));
  expect(expired?.status).toBe("expired");

  await appendCreditAdjustment(handle.db, {
    accountId,
    kind: "refund",
    units: -75,
    idempotencyKey: "paddle:transaction:txn_expiry:refund:1",
  });
  expect((await getCreditBalance(handle.db, accountId)).availableUnits).toBe(-15);
  await expect(reserveCredits(handle.db, {
    accountId,
    operationId: "solver:blocked",
    category: "solver",
    units: 1,
  })).rejects.toMatchObject({ code: "credit_insufficient" });
});

it("releases unused reservations idempotently", async () => {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "credits_release" });
  await appendCreditAdjustment(handle.db, {
    accountId,
    kind: "adjustment",
    units: 25,
    idempotencyKey: "fixture:credits_release:topup",
  });
  const reservation = await reserveCredits(handle.db, {
    accountId,
    operationId: "solver:not-submitted",
    category: "solver",
    units: 10,
  });
  await expect(releaseCreditReservation(handle.db, { accountId, reservationId: reservation.id }))
    .resolves.toMatchObject({ status: "released" });
  await expect(releaseCreditReservation(handle.db, { accountId, reservationId: reservation.id }))
    .resolves.toMatchObject({ status: "released" });
  expect(await getCreditBalance(handle.db, accountId)).toEqual({
    availableUnits: 25,
    reservedUnits: 0,
    totalUnits: 25,
  });
});
