import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentExecutor, createLlm, type Llm } from "@tabductor/agent";
import {
  createEndpointPool,
  playwrightDriver,
  type BlobStore,
  type EndpointPool,
  type TraceRecorder,
} from "@tabductor/browser";
import { createDispatcher, type Dispatcher } from "@tabductor/bus";
import { newId } from "@tabductor/core";
import { cdpEndpoints, traceEntries, type TaskRow, type TraceEntryRow } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createEngine, executorKey, StubExecutor, type Engine } from "@tabductor/engine";
import { AllowAllGate, type PolicyGate } from "@tabductor/policy";
import {
  createTestBlobStore,
  launchChrome,
  startFixtures,
  type Chrome,
  type Fixtures,
} from "@tabductor/testkit";
import { asc, eq } from "drizzle-orm";

/**
 * Rig for the S4b system tests: the same real Postgres/bus/engine/pool/Chrome/fixture stack
 * `scripted-support.ts` (S3b) drives, with `AgentExecutor` registered for mode `ai` instead
 * of (alongside) `ScriptedBrowserExecutor` — `stub` stays registered too, since the canonical
 * flow's downstream consumer is a `StubExecutor` task by design (S2's permanently-useful
 * harness, per impl-phases Phase 2).
 *
 * Replay fixtures are checked in with a literal `__FX_URL__` token in place of the fixture
 * server's origin, because that origin is a random port chosen at `startFixtures()` time and
 * cannot be baked into a file `git` tracks. `fixtureFor` maps a task to a fixture *name*;
 * this file resolves the name to a rendered, run-specific path once per name.
 */

export type AgentRig = {
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

export type StartAgentRigOptions = {
  chrome?: Chrome;
  gate?: PolicyGate;
  /**
   * Which checked-in transcript (a file name under `fixtures/transcripts/`) a task's runs
   * replay. Keyed by task, not hardcoded to one file, because the milestone test drives two
   * different agent tasks with two different scripts in the same rig. Ignored when `llmFor`
   * is given directly (the live-eval suite's case — there is no transcript to pick).
   */
  fixtureFor?: (task: TaskRow) => string;
  /** Test-only observation seam: wraps the per-run `Llm` so a test can inspect the exact
   * requests the loop sends (e.g. "does the next request carry the network body I just
   * read?") without the replay adapter itself needing to expose anything for it. Ignored
   * when `llmFor` is given directly. */
  wrapLlm?: (llm: Llm, task: TaskRow) => Llm;
  /** Escape hatch for the live-eval suite (`tests/live-eval/`): build the `Llm` directly
   * (mode `live`) instead of resolving a checked-in transcript. When given, `fixtureFor` and
   * `wrapLlm` are ignored. */
  llmFor?: (opts: { trace: TraceRecorder; task: TaskRow }) => Llm;
};

function renderTranscript(name: string, fxUrl: string, cache: Map<string, string>, scratchDir: string): string {
  const cached = cache.get(name);
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(path.join(here, "fixtures", "transcripts", name), "utf8");
  const rendered = raw.replaceAll("__FX_URL__", fxUrl);
  const out = path.join(scratchDir, name);
  writeFileSync(out, rendered);
  cache.set(name, out);
  return out;
}

export async function startAgentRig(opts: StartAgentRigOptions): Promise<AgentRig> {
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
  const scratchDir = mkdtempSync(path.join(tmpdir(), "tabductor-agent-transcripts-"));
  const rendered = new Map<string, string>();

  const executor = createAgentExecutor({
    pool,
    gate,
    blobs,
    db: handle.db,
    defaultEndpointId: endpointId,
    llmFor: ({ trace, task }) => {
      if (opts.llmFor) return opts.llmFor({ trace, task });
      if (!opts.fixtureFor) {
        throw new Error("startAgentRig needs either `fixtureFor` or `llmFor`");
      }
      const fixturePath = renderTranscript(opts.fixtureFor(task), fx.url, rendered, scratchDir);
      const llm = createLlm("replay", { fixturePath, trace });
      return opts.wrapLlm ? opts.wrapLlm(llm, task) : llm;
    },
  });

  const dispatcher = createDispatcher(handle, { intervalMs: 25, backoffBaseMs: 10 });
  const engine = createEngine({
    db: handle.db,
    dispatcher,
    executors: { [executorKey("browser", "stub")]: StubExecutor, [executorKey("browser", "ai")]: executor },
    watchdogIntervalMs: 50,
    // A real page load and a real form POST are slower than a stub; long enough that
    // teardown never races a run still mid-navigation.
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

export async function traceRowsFor(rig: AgentRig, runId: string): Promise<TraceEntryRow[]> {
  return rig.handle.db.select().from(traceEntries).where(eq(traceEntries.runId, runId)).orderBy(asc(traceEntries.seq));
}

export async function waitForTraceRows(
  rig: AgentRig,
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

/** `GET /fake-gram/admin/submissions` — the milestone test's "exactly one post" assertion. */
export async function fakeGramSubmissionCount(rig: AgentRig): Promise<number> {
  const res = await fetch(`${rig.fx.url}/fake-gram/admin/submissions`);
  const body = (await res.json()) as { submissions: unknown[] };
  return body.submissions.length;
}
