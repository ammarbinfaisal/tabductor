import { afterEach, expect, it } from "vitest";
import {
  claimCompileJob,
  enqueueCompileJob,
  finishCompileJob,
  COMPILE_JOB_STALE_MS,
} from "@tabductor/compiler";
import { compileJobs, runs, type RunStatus } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { seedWorkflow } from "@tabductor/engine/testing";
import { newId } from "@tabductor/core";
import { eq } from "drizzle-orm";

/**
 * The queue that makes compilation a separate task, tested where it is load-bearing.
 *
 * The timing rule is the one that matters: **a job whose source run has not settled is not
 * claimable.** `trace-compilation.md` asks for the run's terminal outcome to be persisted and
 * its trace flushed before compilation begins, and putting that in the claim query is what
 * makes it true of every caller rather than of whichever caller remembered to wait.
 */

let handle: MigratedTestDb | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function fresh(): Promise<{ db: MigratedTestDb["db"]; taskId: string; versionId: string }> {
  handle = await createMigratedTestDb();
  const wf = await seedWorkflow(handle.db, { tasks: { T: { mode: "ai", prompt: "Work." } } });
  return { db: handle.db, taskId: wf.taskIds.T!, versionId: wf.versionId };
}

async function runRow(
  db: MigratedTestDb["db"],
  ctx: { taskId: string; versionId: string },
  status: RunStatus,
): Promise<string> {
  const id = newId("run");
  await db.insert(runs).values({ id, taskId: ctx.taskId, workflowVersionId: ctx.versionId, status, modeUsed: "ai" });
  return id;
}

it("a job whose run is still in flight is not claimable, and becomes claimable the moment it settles", async () => {
  const { db, taskId, versionId } = await fresh();
  const runId = await runRow(db, { taskId, versionId }, "running");
  const job = await enqueueCompileJob(db, { taskId, runId, reason: "promote", contentHash: "h1" });
  expect(job).not.toBeNull();

  expect(await claimCompileJob(db)).toBeNull();

  await db.update(runs).set({ status: "succeeded" }).where(eq(runs.id, runId));
  const claimed = await claimCompileJob(db);
  expect(claimed).toMatchObject({ id: job!.id, status: "running", attempts: 1 });
  expect(claimed!.heartbeatAt).not.toBeNull();
});

it("a second eligible run while a compile is open adds evidence, not a second compile", async () => {
  const { db, taskId, versionId } = await fresh();
  const first = await runRow(db, { taskId, versionId }, "succeeded");
  const second = await runRow(db, { taskId, versionId }, "succeeded");

  expect(await enqueueCompileJob(db, { taskId, runId: first, reason: "promote", contentHash: "h1" })).not.toBeNull();
  expect(await enqueueCompileJob(db, { taskId, runId: second, reason: "promote", contentHash: "h1" })).toBeNull();
  expect(await db.select().from(compileJobs).where(eq(compileJobs.taskId, taskId))).toHaveLength(1);

  // Once the first one is done, the next eligible run may queue its own.
  const claimed = (await claimCompileJob(db))!;
  await finishCompileJob(db, claimed, { status: "refused", error: "plan: not grounded" });
  expect(await enqueueCompileJob(db, { taskId, runId: second, reason: "promote", contentHash: "h1" })).not.toBeNull();
});

it("only one worker claims a job", async () => {
  const { db, taskId, versionId } = await fresh();
  const runId = await runRow(db, { taskId, versionId }, "succeeded");
  await enqueueCompileJob(db, { taskId, runId, reason: "promote", contentHash: "h1" });

  const [a, b] = await Promise.all([claimCompileJob(db), claimCompileJob(db)]);
  expect([a, b].filter((x) => x !== null)).toHaveLength(1);
});

/**
 * A refusal is the model having read the evidence and the gates having said no. Running the
 * same evidence through the same gates again says no again, so it is terminal on the first
 * attempt — the distinction from a transport failure, which is retried.
 */
it("a refusal is terminal; a failure is retried until its own budget is spent", async () => {
  const { db, taskId, versionId } = await fresh();
  const runId = await runRow(db, { taskId, versionId }, "succeeded");
  await enqueueCompileJob(db, { taskId, runId, reason: "promote", contentHash: "h1" });

  const first = (await claimCompileJob(db))!;
  await finishCompileJob(db, first, { status: "failed", error: "provider timed out" });
  const [requeued] = await db.select().from(compileJobs).where(eq(compileJobs.id, first.id));
  expect(requeued).toMatchObject({ status: "queued", attempts: 1 });
  expect(requeued!.notBefore.getTime()).toBeGreaterThan(Date.now());

  // Due again (the backoff is in the row, so a test moves the clock by moving the row).
  await db.update(compileJobs).set({ notBefore: new Date(Date.now() - 1000) }).where(eq(compileJobs.id, first.id));
  const second = (await claimCompileJob(db))!;
  expect(second.attempts).toBe(2);
  await finishCompileJob(db, second, { status: "failed", error: "provider timed out again" });
  const [spent] = await db.select().from(compileJobs).where(eq(compileJobs.id, first.id));
  expect(spent!.status).toBe("failed");

  // A fresh job, refused: no second attempt at all.
  const other = await runRow(db, { taskId, versionId }, "succeeded");
  await enqueueCompileJob(db, { taskId, runId: other, reason: "promote", contentHash: "h1" });
  const refused = (await claimCompileJob(db))!;
  await finishCompileJob(db, refused, { status: "refused", error: "plan: step 2 uses a selector no trace addressed" });
  const [done] = await db.select().from(compileJobs).where(eq(compileJobs.id, refused.id));
  expect(done).toMatchObject({ status: "refused", attempts: 1 });
  expect(done!.error).toContain("no trace addressed");
  expect(done!.endedAt).not.toBeNull();
});

/** An engine that dies mid-compile must not take the eligibility a real run paid for with it. */
it("a claim whose worker went away is reclaimed once its heartbeat goes stale", async () => {
  const { db, taskId, versionId } = await fresh();
  const runId = await runRow(db, { taskId, versionId }, "succeeded");
  await enqueueCompileJob(db, { taskId, runId, reason: "promote", contentHash: "h1" });

  const claimed = (await claimCompileJob(db))!;
  expect(await claimCompileJob(db)).toBeNull();

  await db
    .update(compileJobs)
    .set({ heartbeatAt: new Date(Date.now() - COMPILE_JOB_STALE_MS - 1000) })
    .where(eq(compileJobs.id, claimed.id));

  const reclaimed = await claimCompileJob(db);
  expect(reclaimed).toMatchObject({ id: claimed.id, attempts: 2 });
});
