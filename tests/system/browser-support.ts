import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import {
  createFsBlobStore,
  createTraceRecorder,
  openRunSession,
  playwrightDriver,
  type BlobStore,
  type BrowserConn,
  type RunSession,
  type StorageFlags,
  type TraceRecorder,
} from "@tabductor/browser";
import { newId } from "@tabductor/core";
import {
  artifacts,
  createMigratedTestDb,
  runs,
  traceEntries,
  type ArtifactRow,
  type MigratedTestDb,
  type TraceEntryRow,
} from "@tabductor/db";
import { seedWorkflow } from "@tabductor/engine";
import { AllowAllGate, type PolicyGate } from "@tabductor/policy";
import { launchChrome, startFixtures, type Chrome, type Fixtures } from "@tabductor/testkit";

/**
 * Rig for the Phase 3 system tests: a real migrated Postgres, real headless Chrome over
 * real CDP, the fixture sites, and a blob store on a throwaway directory. Nothing is
 * stubbed — the browser layer's whole claim is that it drives a user-style endpoint, and a
 * fake endpoint would test the fake.
 *
 * Chrome and the fixtures are started once per file and shared; a *run* is per test, since
 * `trace_entries.seq` is per run and tests read it by position.
 */
export type BrowserRig = {
  handle: MigratedTestDb;
  chrome: Chrome;
  fx: Fixtures;
  blobs: BlobStore;
  blobDir: string;
  taskId: string;
  versionId: string;
  close: () => Promise<void>;
};

export async function startBrowserRig(): Promise<BrowserRig> {
  const [handle, chrome, fx, blobDir] = await Promise.all([
    createMigratedTestDb(),
    launchChrome(),
    startFixtures(),
    mkdtemp(path.join(tmpdir(), "tabductor-blobs-")),
  ]);
  const wf = await seedWorkflow(handle.db, { tasks: { browse: {} } });

  return {
    handle,
    chrome,
    fx,
    blobs: createFsBlobStore(blobDir),
    blobDir,
    taskId: wf.taskIds.browse!,
    versionId: wf.versionId,
    close: async () => {
      await Promise.all([chrome.close(), fx.close(), handle.close()]);
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}

/** A `running` run row to hang a trace off — the FK target, nothing more. */
export async function newRun(rig: BrowserRig): Promise<string> {
  const id = newId("run");
  await rig.handle.db.insert(runs).values({
    id,
    taskId: rig.taskId,
    workflowVersionId: rig.versionId,
    status: "running",
    modeUsed: "browser",
  });
  return id;
}

export type SessionRig = {
  runId: string;
  conn: BrowserConn;
  session: RunSession;
  trace: TraceRecorder;
  close: () => Promise<void>;
};

/**
 * Connects, opens a guarded and traced session, and hands back the pieces a test asserts
 * on. The gate defaults to the fixture host only, which is the `HARNESS_NAV_ALLOWLIST`
 * carve-out (impl-phases §0.1) doing its job in the tests as well as in development.
 */
export async function openSession(
  rig: BrowserRig,
  opts: { gate?: PolicyGate; storage?: StorageFlags } = {},
): Promise<SessionRig> {
  const runId = await newRun(rig);
  const trace = createTraceRecorder(rig.handle.db, rig.blobs, runId, opts.storage ?? {});
  const conn = await playwrightDriver.connect(rig.chrome.wsUrl);
  const session = await openRunSession({
    conn,
    gate: opts.gate ?? new AllowAllGate({ navAllowlist: ["127.0.0.1"] }),
    taskCtx: { taskId: rig.taskId, runId },
    trace,
  });

  return {
    runId,
    conn,
    session,
    trace,
    close: async () => {
      await session.close();
      await conn.close();
    },
  };
}

export async function traceRows(rig: BrowserRig, runId: string): Promise<TraceEntryRow[]> {
  return rig.handle.db
    .select()
    .from(traceEntries)
    .where(eq(traceEntries.runId, runId))
    .orderBy(asc(traceEntries.seq));
}

export async function artifactRows(rig: BrowserRig, runId: string): Promise<ArtifactRow[]> {
  return rig.handle.db.select().from(artifacts).where(eq(artifacts.runId, runId));
}

/** Everything the blob store has actually written, so "nothing was stored" is checkable. */
export async function blobFiles(rig: BrowserRig): Promise<string[]> {
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  };
  return walk(rig.blobDir);
}

/**
 * Polls the trace for an entry, flushing first — the recorder buffers, and a navigation the
 * *page* caused (a redirect, a popup) lands whenever the browser gets to it rather than
 * when the caller's await returns.
 */
export async function waitForTrace(
  rig: BrowserRig,
  sess: SessionRig,
  what: string,
  predicate: (rows: TraceEntryRow[]) => boolean,
  timeoutMs = 15_000,
): Promise<TraceEntryRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: TraceEntryRow[] = [];
  while (Date.now() < deadline) {
    await sess.trace.flush();
    rows = await traceRows(rig, sess.runId);
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}; trace was ${JSON.stringify(rows, null, 2)}`);
}

export type Payload = Record<string, unknown>;

export const payloadOf = (row: TraceEntryRow): Payload => row.payloadJson as Payload;
