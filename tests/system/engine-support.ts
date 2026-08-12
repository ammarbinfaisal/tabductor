import { createDispatcher, publish, type Dispatcher } from "@tabductor/bus";
import { createEngine, type Engine, type EngineDeps, type ExecutorRegistry } from "@tabductor/engine";
import { events, outbox, runs, type EventRow, type RunRow } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { asc, eq, inArray } from "drizzle-orm";

/**
 * Shared rig for the engine system tests: a real migrated Postgres, the real outbox bus,
 * and the real engine. Nothing here is a mock — the point of Phase 2 is that the engine is
 * provable without a browser, not that it is provable without a database.
 */

export type Rig = {
  handle: MigratedTestDb;
  dispatcher: Dispatcher;
  engine: Engine;
  stop: () => Promise<void>;
};

export type RigOptions = {
  watchdogIntervalMs?: number;
  shutdownGraceMs?: number;
  heartbeatIntervalMs?: number;
  staleHeartbeatMs?: number;
  /** Passed straight through to the engine; `false` leaves the scheduler off. */
  scheduler?: EngineDeps["scheduler"];
  /** Reuse an already-migrated DB instead of creating one — how a restart is simulated. */
  handle?: MigratedTestDb;
  /** Defaults to `createEngine`'s own default (`{ "browser:stub": StubExecutor }`) — pass
   * this to also exercise `AssetExecutor` or another `(kind, mode)` registration. */
  executors?: ExecutorRegistry;
};

export async function startRig(opts: RigOptions = {}): Promise<Rig> {
  const handle = opts.handle ?? (await createMigratedTestDb());
  const dispatcher = createDispatcher(handle, { intervalMs: 25, backoffBaseMs: 10 });
  const engine = createEngine({
    db: handle.db,
    dispatcher,
    ...(opts.executors ? { executors: opts.executors } : {}),
    watchdogIntervalMs: opts.watchdogIntervalMs ?? 50,
    // A deliberately hanging stub must not hold teardown open; the timeout test relies on it.
    shutdownGraceMs: opts.shutdownGraceMs ?? 250,
    ...(opts.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: opts.heartbeatIntervalMs }),
    ...(opts.staleHeartbeatMs === undefined ? {} : { staleHeartbeatMs: opts.staleHeartbeatMs }),
    // Off unless a test asks for it: a scheduler ticking through every unrelated suite is
    // noise, and the schedules table is empty in all of them anyway.
    scheduler: opts.scheduler ?? false,
  });
  await engine.start();
  await dispatcher.start();

  return {
    handle,
    dispatcher,
    engine,
    stop: async () => {
      await dispatcher.stop();
      await engine.stop();
      if (!opts.handle) await handle.close();
    },
  };
}

/**
 * Polls until `predicate` returns something truthy, with a deadline. Every wait in these
 * tests is a wait on DB state rather than a fixed sleep: the engine, the dispatcher and the
 * watchdog each run on their own clock, and a sleep long enough to be reliable is long
 * enough to make the suite slow.
 */
export async function waitFor<T>(
  what: string,
  predicate: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Waits for the graph to come to rest: no outbox row still pending and no run still
 * queued or running. This is the "nothing more will happen" assertion that lets a test
 * then check a *count* without racing the engine.
 *
 * Rest has to be observed *twice* in a row. A run that fails and is about to be retried
 * spends a moment terminal with an empty outbox — the retry row is inserted just after the
 * failure commits — and a single-shot check would read that instant as the end of the
 * story.
 */
export async function waitForQuiet(rig: Rig, timeoutMs = 20_000): Promise<void> {
  let quiet = 0;
  await waitFor(
    "the engine to settle",
    async () => {
      const pending = await rig.handle.db
        .select({ id: outbox.id })
        .from(outbox)
        .where(eq(outbox.status, "pending"))
        .limit(1);

      // Only `queued`/`running` are busy — a failed or timed-out run is at rest.
      const busy = await rig.handle.db
        .select({ id: runs.id })
        .from(runs)
        .where(inArray(runs.status, ["queued", "running"]))
        .limit(1);

      quiet = pending.length === 0 && busy.length === 0 ? quiet + 1 : 0;
      return quiet >= 2;
    },
    timeoutMs,
  );
}

/**
 * Injects the event that starts a graph, attributed to `taskId` so the dispatcher can
 * resolve which workflow (and version) it belongs to. This stands in for the schedule fire
 * that S2b will add — schedules are just another event source (§7).
 */
export async function trigger(
  on: { handle: MigratedTestDb },
  taskId: string,
  type: string,
  packet: unknown = {},
): Promise<EventRow> {
  return on.handle.db.transaction((trx) =>
    publish(trx, { type, sourceTaskId: taskId, packet }),
  );
}

export async function runsForTask(rig: Rig, taskId: string): Promise<RunRow[]> {
  return rig.handle.db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.createdAt));
}

export async function allRuns(rig: Rig): Promise<RunRow[]> {
  return rig.handle.db.select().from(runs).orderBy(asc(runs.createdAt));
}

export async function eventsOfType(rig: Rig, type: string): Promise<EventRow[]> {
  return rig.handle.db.select().from(events).where(eq(events.type, type)).orderBy(asc(events.occurredAt));
}
