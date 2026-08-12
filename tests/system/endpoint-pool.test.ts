import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createEndpointPool, playwrightDriver, type EndpointPool } from "@tabductor/browser";
import { newId } from "@tabductor/core";
import {
  cdpEndpoints,
  endpointLeases,
  events,
  runs,
} from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { seedWorkflow } from "@tabductor/engine";
import { launchChrome, type Chrome } from "@tabductor/testkit";
import { eq } from "drizzle-orm";

/**
 * S3b deliverables 1–3: the `cdp_endpoints`/`endpoint_leases` tables, the pool that
 * connects lazily and health-checks, and the DB-backed per-endpoint lease that serializes
 * runs. Real Chrome via testkit's launcher (the BYO-CDP simulator), real migrated
 * Postgres — no fixture sites needed, since nothing here drives a page.
 *
 * Two Chrome instances are started once and shared: acquiring and releasing detaches
 * rather than closing (S3a), so the same endpoint can be reused test to test. The
 * disconnect test needs its own disposable instance, since it is the one thing that
 * actually kills a browser.
 */

let handle: MigratedTestDb;
let chromeA: Chrome;
let chromeB: Chrome;
let taskId: string;
let versionId: string;
let pools: EndpointPool[];
let extraChromes: Chrome[];

beforeAll(async () => {
  [chromeA, chromeB] = await Promise.all([launchChrome(), launchChrome()]);
});

afterAll(async () => {
  await Promise.all([chromeA.close(), chromeB.close()]);
});

beforeEach(async () => {
  handle = await createMigratedTestDb();
  const wf = await seedWorkflow(handle.db, { tasks: { browse: {} } });
  taskId = wf.taskIds.browse!;
  versionId = wf.versionId;
  pools = [];
  extraChromes = [];
});

afterEach(async () => {
  await Promise.all(pools.map((p) => p.close()));
  await Promise.all(extraChromes.map((c) => c.close()));
  await handle.close();
});

/** Every pool a test creates must be closed, or its health/reconnect timers leak past the
 * test — tracked here rather than trusted to each test's own bookkeeping. */
function pool(deps: Partial<Parameters<typeof createEndpointPool>[0]> = {}): EndpointPool {
  const p = createEndpointPool({ db: handle.db, driver: playwrightDriver, ...deps });
  pools.push(p);
  return p;
}

async function newRun(): Promise<string> {
  const id = newId("run");
  await handle.db.insert(runs).values({ id, taskId, workflowVersionId: versionId, status: "running", modeUsed: "browser" });
  return id;
}

async function newEndpoint(wsUrl: string, opts: { maxQueueDepth?: number } = {}): Promise<string> {
  const id = newId("endpoint");
  await handle.db.insert(cdpEndpoints).values({
    id,
    wsUrl,
    maxQueueDepth: opts.maxQueueDepth ?? 10,
  });
  return id;
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)),
  ]);
}

it("serializes two runs against one endpoint: the second is granted only once the first releases", async () => {
  const endpointId = await newEndpoint(chromeA.wsUrl);
  const p = pool();
  const runA = await newRun();
  const runB = await newRun();

  const order: string[] = [];
  const leaseA = await p.acquire(endpointId, runA);
  order.push("A-acquired");

  const bAcquired = p.acquire(endpointId, runB).then((leaseB) => {
    order.push("B-acquired");
    return leaseB;
  });

  // Long enough that a bug granting B immediately would already show up here.
  await new Promise((r) => setTimeout(r, 250));
  expect(order).toEqual(["A-acquired"]);

  order.push("A-released");
  await leaseA.release();

  const leaseB = await withTimeout(bAcquired, 5_000, "B's queued acquire");
  expect(order).toEqual(["A-acquired", "A-released", "B-acquired"]);
  await leaseB.release();
});

it("two endpoints run in parallel: neither's acquire waits on the other's release", async () => {
  const ep1 = await newEndpoint(chromeA.wsUrl);
  const ep2 = await newEndpoint(chromeB.wsUrl);
  const p = pool();
  const run1 = await newRun();
  const run2 = await newRun();

  // If serialization leaked across endpoints, the second acquire would hang on the
  // first's release, which never happens here before both are awaited — the test's own
  // timeout is the proof of a regression.
  const [lease1, lease2] = await withTimeout(
    Promise.all([p.acquire(ep1, run1), p.acquire(ep2, run2)]),
    5_000,
    "both endpoints to grant concurrently",
  );
  await Promise.all([lease1.release(), lease2.release()]);
});

it("a queue beyond max_queue_depth rejects endpoint_queue_full; the queued run still gets served", async () => {
  const endpointId = await newEndpoint(chromeA.wsUrl, { maxQueueDepth: 1 });
  const p = pool();
  const runHolder = await newRun();
  const runWaiter = await newRun();
  const runRejected = await newRun();

  const holderLease = await p.acquire(endpointId, runHolder);
  const waiterPromise = p.acquire(endpointId, runWaiter);
  // Give the waiter's acquire time to reach the in-process queue before probing depth —
  // otherwise both could race to see an empty queue and both would be admitted.
  await new Promise((r) => setTimeout(r, 200));

  await expect(p.acquire(endpointId, runRejected)).rejects.toMatchObject({ code: "endpoint_queue_full" });

  await holderLease.release();
  const waiterLease = await withTimeout(waiterPromise, 5_000, "the queued run's grant");
  await waiterLease.release();
});

it("a stale lease is reaped by the next acquire rather than queued behind forever", async () => {
  const endpointId = await newEndpoint(chromeA.wsUrl);
  const deadRunId = newId("run"); // a run that crashed without releasing
  await handle.db.insert(endpointLeases).values({
    endpointId,
    runId: deadRunId,
    heartbeatAt: new Date(Date.now() - 60_000),
  });

  const p = pool({ leaseStaleMs: 5_000 });
  const run = await newRun();

  const lease = await withTimeout(p.acquire(endpointId, run), 5_000, "acquire to reap the stale lease");
  await lease.release();

  const [row] = await handle.db.select().from(endpointLeases).where(eq(endpointLeases.endpointId, endpointId));
  expect(row).toBeUndefined();
});

it("a disconnect mid-lease surfaces browser.disconnected, marks the endpoint unhealthy, and recovers after relaunch", async () => {
  const disposable = await launchChrome();
  const endpointId = await newEndpoint(disposable.wsUrl);
  const p = pool({ healthCheckMs: 200, backoffBaseMs: 100, backoffMaxMs: 500 });
  const run = await newRun();

  const lease = await p.acquire(endpointId, run);
  // Establish the real connection before pulling it out from under the lease.
  await lease.conn.version();

  await disposable.close();

  await waitFor(async () => {
    const [row] = await handle.db.select().from(cdpEndpoints).where(eq(cdpEndpoints.id, endpointId));
    return row?.healthy === false;
  }, "endpoint marked unhealthy");

  // By the time `healthy` flips in the DB the pool has already marked the connection dead
  // (same synchronous handler, DB write is the async tail of it) — so the next call on the
  // held conn is guaranteed to hit the typed guard rather than race a raw Playwright error.
  await expect(lease.conn.createPage()).rejects.toMatchObject({ code: "browser.disconnected" });

  const disconnectEvents = await handle.db.select().from(events).where(eq(events.type, "browser.disconnected"));
  expect(disconnectEvents).toHaveLength(1);
  expect(disconnectEvents[0]!.packet).toMatchObject({ endpointId, runId: run });
  // The endpoint's ws_url is a bearer credential (§16 Threat 5) — it must never appear in
  // an event payload, even the one reporting that the endpoint using it went down.
  expect(JSON.stringify(disconnectEvents)).not.toContain(disposable.wsUrl);

  await lease.release();

  // Relaunching gives a fresh browser a fresh debugger path (a new UUID segment), so a
  // fixed port could not make the ws:// URL match again — updating the endpoint row is
  // what actually works, and it is also what a user does after restarting their own
  // browser and repasting its new endpoint.
  const relaunched = await launchChrome();
  extraChromes.push(relaunched);
  await handle.db.update(cdpEndpoints).set({ wsUrl: relaunched.wsUrl }).where(eq(cdpEndpoints.id, endpointId));

  await waitFor(async () => {
    const [row] = await handle.db.select().from(cdpEndpoints).where(eq(cdpEndpoints.id, endpointId));
    return row?.healthy === true;
  }, "endpoint healthy again after relaunch");

  const run2 = await newRun();
  const lease2 = await withTimeout(p.acquire(endpointId, run2), 5_000, "a fresh acquire after recovery");
  expect(await lease2.conn.version()).toMatch(/\d+\./);
  await lease2.release();
});
