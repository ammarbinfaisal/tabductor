import { AppError } from "@tabductor/core";
import { runs, type Db } from "@tabductor/db";
import { and, eq } from "drizzle-orm";

/** Call inside the transaction that commits the effect. The row lock serializes the
 * commit with cancellation, timeout, and lease replacement, including across processes. */
export async function assertRunLease(trx: Db, runId: string, generation: number): Promise<void> {
  const [active] = await trx.select({ id: runs.id }).from(runs).where(and(
    eq(runs.id, runId), eq(runs.status, "running"), eq(runs.leaseGeneration, generation),
  )).for("update");
  if (!active) throw new AppError("run_lease_lost", "run ownership ended");
}
