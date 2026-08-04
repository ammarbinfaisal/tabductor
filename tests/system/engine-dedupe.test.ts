import { afterEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { seedWorkflow } from "@tabductor/engine";
import { outbox, runDedupe, runs } from "@tabductor/db";
import { allRuns, runsForTask, startRig, trigger, waitFor, waitForQuiet, type Rig } from "./engine-support.js";

let rig: Rig;

afterEach(async () => {
  await rig?.stop();
});

/**
 * Delivery is at-least-once (§6), so the engine must be idempotent per `(task, event)`:
 * the claim is taken before the run row is created, and a redelivery finds it taken.
 * Resetting the outbox row is exactly what a dispatcher that crashed mid-delivery leaves
 * behind, which is why it is the fixture here.
 */
it("creates no second run when the trigger event is redelivered", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Worker: { stub: { emits: [{ type: "worker.done", packet: {} }] } },
      Downstream: {},
    },
    edges: [
      ["Start", "work.requested", "Worker"],
      ["Worker", "worker.done", "Downstream"],
    ],
  });

  const start = await trigger(rig, wf.taskIds.Start!, "work.requested");
  await waitForQuiet(rig);
  expect(await runsForTask(rig, wf.taskIds.Worker!)).toHaveLength(1);
  const before = await allRuns(rig);

  // Force the redelivery a crashed dispatcher would cause.
  await rig.handle.db
    .update(outbox)
    .set({ status: "pending", dispatchedAt: null })
    .where(eq(outbox.eventId, start.eventId));

  await waitFor("the redelivery to be dispatched", async () => {
    const [row] = await rig.handle.db.select().from(outbox).where(eq(outbox.eventId, start.eventId));
    return row?.status === "dispatched";
  });
  await waitForQuiet(rig);

  // Same runs as before: no duplicate for Worker, and nothing new downstream either.
  expect(await runsForTask(rig, wf.taskIds.Worker!)).toHaveLength(1);
  expect(await allRuns(rig)).toHaveLength(before.length);

  // One claim row is what made that true.
  const claims = await rig.handle.db
    .select()
    .from(runDedupe)
    .where(eq(runDedupe.eventId, start.eventId));
  expect(claims).toHaveLength(1);
  expect(claims[0]!.taskId).toBe(wf.taskIds.Worker);
});

/**
 * The claim and the run insert must commit together. A claim that survived a failed insert
 * would be worse than no dedupe at all: every redelivery would report `duplicate` and the
 * trigger would be lost permanently, silently, with no run to show for it.
 *
 * The failure is induced in Postgres rather than by stubbing the engine, so what is under
 * test is the real transaction boundary. The trigger fires once, which also lets the
 * event's own outbox retry prove the recovery path: the second delivery succeeds.
 */
it("rolls the dedupe claim back when the run insert fails, so the event is retried not lost", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Start: {}, Worker: {} },
    edges: [["Start", "work.requested", "Worker"]],
  });

  // Explode on the first run insert only; later inserts pass straight through. The counter
  // is a sequence because it has to survive the very rollback it triggers — a flag in a
  // table would be rolled back with it and the fault would fire forever.
  await rig.handle.db.execute(sql`
    CREATE SEQUENCE run_insert_attempts;
    CREATE FUNCTION fail_first_run() RETURNS trigger AS $$
    BEGIN
      IF nextval('run_insert_attempts') = 1 THEN
        RAISE EXCEPTION 'induced run insert failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_first_run_trigger BEFORE INSERT ON runs
      FOR EACH ROW EXECUTE FUNCTION fail_first_run();
  `);

  const start = await trigger(rig, wf.taskIds.Start!, "work.requested");

  // The first attempt fails; the bus redelivers and the second attempt lands the run.
  await waitFor("the run to be created on retry", async () => {
    const [row] = await runsForTask(rig, wf.taskIds.Worker!);
    return row?.status === "succeeded" ? row : false;
  });
  await waitForQuiet(rig);

  // Exactly one run, and exactly one claim — the failed attempt left neither behind.
  expect(await runsForTask(rig, wf.taskIds.Worker!)).toHaveLength(1);
  expect(await allRuns(rig)).toHaveLength(1);

  const claims = await rig.handle.db.select().from(runDedupe).where(eq(runDedupe.eventId, start.eventId));
  expect(claims).toHaveLength(1);

  // The invariant stated directly: no claim without its run.
  const orphaned = await rig.handle.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM run_dedupe d
    WHERE NOT EXISTS (
      SELECT 1 FROM ${runs} r WHERE r.task_id = d.task_id AND r.trigger_event_id = d.event_id
    )
  `);
  expect(orphaned.rows[0]!.n).toBe(0);
});
