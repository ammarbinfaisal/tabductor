import { createDispatcher, type Dispatcher } from "@tabductor/bus";
import { newId } from "@tabductor/core";
import {
  createEndpointPool,
  playwrightDriver,
  type BlobStore,
  type EndpointPool,
} from "@tabductor/browser";
import { cdpEndpoints, traceEntries, type TraceEntryRow } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createEngine, executorKey, type Engine } from "@tabductor/engine";
import { AllowAllGate, type PolicyGate } from "@tabductor/policy";
import {
  createScriptedBrowserExecutor,
  createTestBlobStore,
  launchChrome,
  startFixtures,
  type Chrome,
  type Fixtures,
} from "@tabductor/testkit";
import { asc, eq } from "drizzle-orm";

/**
 * Rig for the S3b deliverable-6 system tests: a real migrated Postgres, the real outbox
 * bus and engine, the real endpoint pool bound to one real Chrome, and the fixture sites —
 * the `ScriptedBrowserExecutor` registered under mode `scripted` is the only executor this
 * engine knows, so every task these tests seed with `mode: "scripted"` runs through the
 * actual pool/gate/session/trace stack, not a stand-in for it.
 *
 * Structurally compatible with `Rig` (`engine-support.ts`) — extra fields, none missing —
 * so `trigger`/`waitFor`/`waitForQuiet`/`runsForTask`/`eventsOfType` all accept it directly.
 */
export type ScriptedRig = {
  handle: MigratedTestDb;
  dispatcher: Dispatcher;
  engine: Engine;
  pool: EndpointPool;
  chrome: Chrome;
  fx: Fixtures;
  blobs: BlobStore;
  endpointId: string;
  gate: PolicyGate;
  stop: () => Promise<void>;
};

export async function startScriptedRig(opts: { chrome?: Chrome; gate?: PolicyGate } = {}): Promise<ScriptedRig> {
  const ownsChrome = !opts.chrome;
  const [handle, chrome, fx, testBlobs] = await Promise.all([
    createMigratedTestDb(),
    opts.chrome ? Promise.resolve(opts.chrome) : launchChrome(),
    startFixtures(),
    createTestBlobStore(),
  ]);
  const blobs = testBlobs.store;
  const gate = opts.gate ?? new AllowAllGate({ navAllowlist: ["127.0.0.1"] });

  const endpointId = newId("endpoint");
  await handle.db.insert(cdpEndpoints).values({ id: endpointId, wsUrl: chrome.wsUrl });

  const pool = createEndpointPool({ db: handle.db, driver: playwrightDriver });
  const executor = createScriptedBrowserExecutor({
    pool,
    gate,
    blobs,
    db: handle.db,
    defaultEndpointId: endpointId,
  });

  const dispatcher = createDispatcher(handle, { intervalMs: 25, backoffBaseMs: 10 });
  const engine = createEngine({
    db: handle.db,
    dispatcher,
    executors: { [executorKey("browser", "scripted")]: executor },
    watchdogIntervalMs: 50,
    // A real page load is slower than a stub; long enough that teardown never races a run
    // that is still mid-navigation, short enough that a genuinely wedged run doesn't hang
    // the suite.
    shutdownGraceMs: 5_000,
  });
  await engine.start();
  await dispatcher.start();

  return {
    handle,
    dispatcher,
    engine,
    pool,
    chrome,
    fx,
    blobs,
    endpointId,
    gate,
    stop: async () => {
      await dispatcher.stop();
      await engine.stop();
      await pool.close();
      await Promise.all([
        ownsChrome ? chrome.close() : Promise.resolve(),
        fx.close(),
        handle.close(),
        testBlobs.drop(),
      ]);
    },
  };
}

export async function traceRowsFor(rig: ScriptedRig, runId: string): Promise<TraceEntryRow[]> {
  return rig.handle.db.select().from(traceEntries).where(eq(traceEntries.runId, runId)).orderBy(asc(traceEntries.seq));
}

/** Polls trace rows until `predicate` holds. Reads are safe to poll straight from the DB
 * here (unlike `browser-support.ts`'s `waitForTrace`): the executor's own `session.close()`
 * flushes the trace recorder before a run's `RunResult` settles, so once a run is observed
 * terminal its trace is already complete — this only covers the moment between "terminal"
 * and the write actually committing. */
export async function waitForTraceRows(
  rig: ScriptedRig,
  runId: string,
  predicate: (rows: TraceEntryRow[]) => boolean,
  timeoutMs = 20_000,
): Promise<TraceEntryRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: TraceEntryRow[] = [];
  while (Date.now() < deadline) {
    rows = await traceRowsFor(rig, runId);
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for trace rows on run ${runId}; had ${JSON.stringify(rows, null, 2)}`);
}
