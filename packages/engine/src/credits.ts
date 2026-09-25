import { AppError, newId } from "@tabductor/core";
import {
  accounts, billingSettings, operatingCosts,
  challengeAttempts,
  captchaJobs,
  browserBilling,
  modelOperations,
  creditLedgerEntries,
  creditReservations,
  type CreditLedgerEntryRow,
  type CreditLedgerKind,
  type CreditReservationRow,
  type CreditUsageCategory,
  type Db,
} from "@tabductor/db";
import { and, asc, eq, lt, sql } from "drizzle-orm";

import { assertUsdAccount } from "./billing-prices.js";
import { usdMicros, scaledAmount } from "@tabductor/core";

const MAX_CREDIT_UNITS = Number.MAX_SAFE_INTEGER;
const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1_000;

export type CreditBalance = {
  availableUnits: number;
  reservedUnits: number;
  totalUnits: number;
};

function assertUnits(units: number, options: { positive?: boolean } = {}): void {
  if (!Number.isSafeInteger(units) || Math.abs(units) > MAX_CREDIT_UNITS || (options.positive ? units <= 0 : units === 0)) {
    throw new AppError("credit_units_invalid", options.positive
      ? "USD millionths must be a positive safe integer"
      : "USD millionths must be a non-zero safe integer");
  }
}

function assertSettlementUnits(units: number, reservedUnits: number): void {
  if (!Number.isSafeInteger(units) || units < 0 || units > reservedUnits) {
    throw new AppError("credit_settlement_invalid", "settled units must be between zero and the reserved amount");
  }
}

export async function lockCreditAccount(db: Db, accountId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`);
}

async function availableUnits(db: Db, accountId: string, moneyUnit = "usd_micro"): Promise<number> {
  const result = await db.select({
    units: sql<number>`coalesce(sum(${creditLedgerEntries.units}), 0)::double precision`,
  }).from(creditLedgerEntries).where(and(eq(creditLedgerEntries.accountId, accountId),eq(creditLedgerEntries.moneyUnit,moneyUnit)));
  return result[0]?.units ?? 0;
}

export async function getCreditBalance(db: Db, accountId: string): Promise<CreditBalance> {
  await assertUsdAccount(db, accountId);
  // Both totals must observe the same PostgreSQL statement snapshot during settlement.
  const result = await db.execute<{ available: number; reserved: number }>(sql`select
    (select coalesce(sum(units), 0)::double precision from ${creditLedgerEntries} where account_id = ${accountId} and money_unit = 'usd_micro') as available,
    (select coalesce(sum(reserved_units), 0)::double precision from ${creditReservations} where account_id = ${accountId} and status = 'active') as reserved`);
  const available = result.rows[0]!.available;
  const reservedUnits = result.rows[0]!.reserved;
  return { availableUnits: available, reservedUnits, totalUnits: available + reservedUnits };
}

export type CreditAdjustmentInput = {
  accountId: string;
  kind: Extract<CreditLedgerKind, "purchase" | "adjustment" | "refund">;
  units: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};

export async function appendCreditAdjustmentLocked(
  db: Db,
  input: CreditAdjustmentInput,
): Promise<CreditLedgerEntryRow> {
  const [account]=await db.select().from(accounts).where(eq(accounts.id,input.accountId));
  const moneyUnit=account?.moneyUnit??"usd_micro";
  const [prior] = await db.select().from(creditLedgerEntries)
    .where(eq(creditLedgerEntries.idempotencyKey, input.idempotencyKey));
  if (prior) {
    const priorUnits=prior.moneyUnit==="legacy_credit"&&moneyUnit==="usd_micro"?BigInt(prior.units)*BigInt(account?.legacyCreditMicros??0):BigInt(prior.units);
    if (prior.accountId !== input.accountId || prior.kind !== input.kind || priorUnits !== BigInt(input.units)) {
      throw new AppError("credit_idempotency_conflict", "idempotency key was already used for a different credit movement");
    }
    return prior;
  }
  const nextBalance = await availableUnits(db, input.accountId,moneyUnit) + input.units;
  if (!Number.isSafeInteger(nextBalance)) {
    throw new AppError("credit_balance_overflow", "credit movement would exceed the supported integer range");
  }
  const [inserted] = await db.insert(creditLedgerEntries).values({
    id: newId("credit"),
    accountId: input.accountId,
    kind: input.kind,
    moneyUnit,
    units: input.units,
    idempotencyKey: input.idempotencyKey,
    metadataJson: input.metadata ?? {},
  }).onConflictDoNothing({ target: creditLedgerEntries.idempotencyKey }).returning();
  if (inserted) return inserted;

  const [existing] = await db.select().from(creditLedgerEntries)
    .where(eq(creditLedgerEntries.idempotencyKey, input.idempotencyKey));
  if (!existing || existing.accountId !== input.accountId || existing.kind !== input.kind || existing.units !== input.units) {
    throw new AppError("credit_idempotency_conflict", "idempotency key was already used for a different credit movement");
  }
  return existing;
}

/** Adds an externally-authorized movement exactly once. Callers derive units server-side. */
export async function appendCreditAdjustment(db: Db, input: CreditAdjustmentInput): Promise<CreditLedgerEntryRow> {
  await assertUsdAccount(db, input.accountId);
  assertUnits(input.units);
  if (input.kind === "purchase" && input.units < 0) {
    throw new AppError("credit_purchase_invalid", "a purchase must add USD balance");
  }
  if (input.kind === "refund" && input.units > 0) {
    throw new AppError("credit_refund_invalid", "a refund must remove USD balance");
  }
  if (!input.idempotencyKey.trim()) throw new AppError("credit_idempotency_invalid", "idempotency key is required");

  return db.transaction(async (trx) => {
    await lockCreditAccount(trx, input.accountId);
    return appendCreditAdjustmentLocked(trx, input);
  });
}

/** Grant a welcome balance once per account, never once per login or restart. */
export async function seedLoginCredits(db: Db, input: { accountId: string; loginId: string }): Promise<CreditLedgerEntryRow | undefined> {
  if (!input.loginId.trim()) throw new AppError("credit_login_invalid", "A verified account is required");
  const [config] = await db.select().from(billingSettings).where(eq(billingSettings.key,"welcome"));
  const units=usdMicros(String(config?.value.amountUsd ?? "0"));
  if(!units)return undefined;
  // Account creation timestamps prevent a later promotion from granting old accounts money.
  const eligible=await db.execute(sql`select 1 from accounts where id=${input.accountId} and money_unit='usd_micro' and created_at >= ${config!.updatedAt}`);
  if(!eligible.rows.length)return undefined;
  return appendCreditAdjustment(db,{accountId:input.accountId,kind:"adjustment",units,
    idempotencyKey:`welcome:${input.accountId}`,metadata:{reason:"welcome_balance",currency:"USD"}});
}

export type ReserveCreditsInput = {
  accountId: string;
  operationId: string;
  category: CreditUsageCategory;
  units: number;
  ttlMs?: number;
  cost?: {provider:string;rateId:string;unitCharge:number;unitCost:number|null};
};

/** Serializes spend admission per account so concurrent operations cannot overspend. */
export async function reserveCredits(db: Db, input: ReserveCreditsInput): Promise<CreditReservationRow> {
  await assertUsdAccount(db, input.accountId);
  assertUnits(input.units, { positive: true });
  if (!input.operationId.trim()) throw new AppError("credit_operation_invalid", "operation id is required");
  const ttlMs = input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) {
    throw new AppError("credit_reservation_ttl_invalid", "reservation timeout must be between one second and 24 hours");
  }

  return db.transaction(async (trx) => {
    await lockCreditAccount(trx, input.accountId);
    const [existing] = await trx.select().from(creditReservations).where(and(
      eq(creditReservations.accountId, input.accountId),
      eq(creditReservations.operationId, input.operationId),
    ));
    if (existing) {
      if (existing.category !== input.category || existing.reservedUnits !== input.units) {
        throw new AppError("credit_operation_conflict", "operation id was already reserved with different terms");
      }
      return existing;
    }

    const available = await availableUnits(trx, input.accountId);
    if (available < input.units) {
      throw new AppError("credit_insufficient", "Insufficient available USD balance", {
        details: { availableUnits: available, requestedUnits: input.units },
      });
    }

    const id = newId("reservation");
    const [reservation] = await trx.insert(creditReservations).values({
      id,
      accountId: input.accountId,
      operationId: input.operationId,
      category: input.category,
      reservedUnits: input.units,
      expiresAt: new Date(Date.now() + ttlMs),
    }).returning();
    await trx.insert(creditLedgerEntries).values({
      id: newId("credit"),
      accountId: input.accountId,
      reservationId: id,
      kind: "reservation_hold",
      units: -input.units,
      idempotencyKey: `reservation:${id}:hold`,
      metadataJson: { operationId: input.operationId, category: input.category },
    });
    if(input.cost) await trx.insert(operatingCosts).values({id:newId("cost"),accountId:input.accountId,category:input.category,
      provider:input.cost.provider,sourceId:reservation!.id,rateId:input.cost.rateId,status:"pending",costMicros:null,
      snapshot:{unitCharge:input.cost.unitCharge,unitCost:input.cost.unitCost}}).onConflictDoNothing();
    return reservation!;
  });
}

async function getLockedReservation(db: Db, reservationId: string, accountId?: string): Promise<CreditReservationRow> {
  const predicates = [eq(creditReservations.id, reservationId)];
  if (accountId) predicates.push(eq(creditReservations.accountId, accountId));
  const [reservation] = await db.select().from(creditReservations)
    .where(and(...predicates)).for("update");
  if (!reservation) throw new AppError("credit_reservation_not_found", "credit reservation does not exist");
  return reservation;
}

/** Settles actual usage once and releases only the unused portion of the hold. */
export async function settleCreditReservation(
  db: Db,
  input: { accountId: string; reservationId: string; actualUnits: number },
): Promise<CreditReservationRow> {
  return db.transaction(async (trx) => {
    await lockCreditAccount(trx, input.accountId);
    const reservation = await getLockedReservation(trx, input.reservationId, input.accountId);
    assertSettlementUnits(input.actualUnits, reservation.reservedUnits);
    if (reservation.status === "settled") {
      if (reservation.settledUnits !== input.actualUnits) {
        throw new AppError("credit_settlement_conflict", "reservation was already settled for a different amount");
      }
      return reservation;
    }
    if (reservation.status !== "active") {
      throw new AppError("credit_reservation_closed", `reservation is already ${reservation.status}`);
    }

    const [cost]=await trx.select().from(operatingCosts).where(and(eq(operatingCosts.sourceId,reservation.id),eq(operatingCosts.category,reservation.category)));
    if(cost?.snapshot) await trx.update(operatingCosts).set({status:"settled",quantity:String(input.actualUnits/cost.snapshot.unitCharge),
      costMicros:input.actualUnits===0?0:cost.snapshot.unitCost===null?null:scaledAmount(input.actualUnits,cost.snapshot.unitCost,cost.snapshot.unitCharge),occurredAt:new Date()}).where(eq(operatingCosts.id,cost.id));
    const unused = reservation.reservedUnits - input.actualUnits;
    if (unused > 0) {
      await trx.insert(creditLedgerEntries).values({
        id: newId("credit"),
        accountId: reservation.accountId,
        reservationId: reservation.id,
        kind: "reservation_settlement",
        moneyUnit:(await trx.select({unit:accounts.moneyUnit}).from(accounts).where(eq(accounts.id,input.accountId)))[0]!.unit,
        units: unused,
        idempotencyKey: `reservation:${reservation.id}:settlement`,
        metadataJson: { actualUnits: input.actualUnits },
      });
    }
    const [updated] = await trx.update(creditReservations).set({
      status: "settled",
      settledUnits: input.actualUnits,
      settledAt: sql`now()`,
    }).where(and(
      eq(creditReservations.id, reservation.id),
      eq(creditReservations.status, "active"),
    )).returning();
    if (!updated) throw new AppError("credit_reservation_stale", "reservation changed while settling");
    return updated;
  });
}

async function closeCreditReservation(
  db: Db,
  input: { accountId: string; reservationId: string; expired: boolean },
): Promise<CreditReservationRow> {
  return db.transaction(async (trx) => {
    await lockCreditAccount(trx, input.accountId);
    const reservation = await getLockedReservation(trx, input.reservationId, input.accountId);
    const targetStatus = input.expired ? "expired" : "released";
    if (reservation.status === targetStatus) return reservation;
    if (reservation.status !== "active") {
      throw new AppError("credit_reservation_closed", `reservation is already ${reservation.status}`);
    }
    await trx.update(operatingCosts).set({status:"settled",costMicros:0,quantity:"0",occurredAt:new Date()}).where(and(eq(operatingCosts.sourceId,reservation.id),eq(operatingCosts.category,reservation.category)));
    await trx.insert(creditLedgerEntries).values({
      id: newId("credit"),
      accountId: reservation.accountId,
      reservationId: reservation.id,
      kind: "reservation_release",
      moneyUnit:(await trx.select({unit:accounts.moneyUnit}).from(accounts).where(eq(accounts.id,input.accountId)))[0]!.unit,
      units: reservation.reservedUnits,
      idempotencyKey: `reservation:${reservation.id}:release`,
      metadataJson: { reason: input.expired ? "expired" : "released" },
    });
    const [updated] = await trx.update(creditReservations).set({
      status: targetStatus,
      settledAt: sql`now()`,
    }).where(and(
      eq(creditReservations.id, reservation.id),
      eq(creditReservations.status, "active"),
    )).returning();
    if (!updated) throw new AppError("credit_reservation_stale", "reservation changed while releasing");
    return updated;
  });
}

export async function releaseCreditReservation(
  db: Db,
  input: { accountId: string; reservationId: string },
): Promise<CreditReservationRow> {
  return closeCreditReservation(db, { ...input, expired: false });
}

/** Reclaims abandoned holds in bounded batches; each release is its own crash-safe transaction. */
export async function expireCreditReservations(db: Db, now = new Date(), limit = 100): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const expired = await db.select({ id: creditReservations.id, accountId: creditReservations.accountId })
    .from(creditReservations).where(and(
      eq(creditReservations.status, "active"),
      lt(creditReservations.expiresAt, now),
      sql`not exists (select 1 from ${modelOperations} where ${modelOperations.reservationId} = ${creditReservations.id})`,
      sql`not exists (select 1 from ${browserBilling} where ${browserBilling.reservationId} = ${creditReservations.id})`,
      sql`not exists (select 1 from ${captchaJobs} where ${captchaJobs.reservationId} = ${creditReservations.id})`,
      sql`not exists (select 1 from ${challengeAttempts} where ${challengeAttempts.reservationId} = ${creditReservations.id})`,
    )).orderBy(asc(creditReservations.expiresAt)).limit(boundedLimit);
  let count = 0;
  for (const reservation of expired) {
    try {
      await closeCreditReservation(db, { ...reservation, reservationId: reservation.id, expired: true });
      count += 1;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "credit_reservation_closed") throw error;
    }
  }
  return count;
}
