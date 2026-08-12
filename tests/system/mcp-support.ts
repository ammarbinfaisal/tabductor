import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetExecutor, createLlm, type Llm } from "@tabductor/agent";
import type { BlobStore, TraceRecorder } from "@tabductor/browser";
import { createDispatcher, type Dispatcher } from "@tabductor/bus";
import { newId } from "@tabductor/core";
import { mcpServers, traceEntries, type NewMcpServer, type TaskRow, type TraceEntryRow } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createEngine, executorKey, StubExecutor, type Engine } from "@tabductor/engine";
import { AllowAllGate, type PolicyGate } from "@tabductor/policy";
import { createSecretsBroker, fileKeyWrapper, type KeyWrapper, type SecretsBrokerHandle } from "@tabductor/secrets";
import { createTestBlobStore, fakeMcpServerConfig, type FakeMcpServerOptions } from "@tabductor/testkit";
import { asc, eq } from "drizzle-orm";

/**
 * Rig for the S5c system tests: the same real Postgres/bus/engine stack `agent-support.ts`
 * (S4b) drives, minus everything that exists only because a browser run needs it — no Chrome,
 * no endpoint pool, no fixture site. `createAssetExecutor` is registered for `(asset, ai)`;
 * `StubExecutor` stays registered for `(browser, stub)` on the off chance a test wants an
 * upstream browser leg, mirroring `agent-support.ts`'s own reasoning for keeping `stub`
 * registered alongside the kind under test.
 *
 * Transcripts need no `__FX_URL__` rendering (`agent-support.ts`'s reason for copying fixtures
 * into a scratch dir before replay) — an asset node has no page, so nothing in these fixtures
 * names a fixture-server origin. Fixture paths are read directly from
 * `fixtures/transcripts/`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const transcriptsDir = path.join(here, "fixtures", "transcripts");

export type McpRig = {
  handle: MigratedTestDb;
  dispatcher: Dispatcher;
  engine: Engine;
  blobs: BlobStore;
  gate: PolicyGate;
  keyWrapper: KeyWrapper;
  secrets: SecretsBrokerHandle;
  stop: () => Promise<void>;
};

export type StartMcpRigOptions = {
  gate?: PolicyGate;
  fixtureFor?: (task: TaskRow) => string;
  wrapLlm?: (llm: Llm, task: TaskRow) => Llm;
  llmFor?: (opts: { trace: TraceRecorder; task: TaskRow }) => Llm;
};

export async function startMcpRig(opts: StartMcpRigOptions = {}): Promise<McpRig> {
  const [handle, testBlobs] = await Promise.all([createMigratedTestDb(), createTestBlobStore()]);
  const blobs = testBlobs.store;
  const gate = opts.gate ?? new AllowAllGate({ navAllowlist: [] });

  const kekDir = mkdtempSync(path.join(tmpdir(), "tabductor-mcp-kek-"));
  const keyWrapper = fileKeyWrapper(path.join(kekDir, "kek.json"));
  const secrets = createSecretsBroker({ db: handle.db, keyWrapper, resolveRun: () => undefined });

  const executor = createAssetExecutor({
    gate,
    blobs,
    db: handle.db,
    secrets,
    llmFor: ({ trace, task }) => {
      if (opts.llmFor) return opts.llmFor({ trace, task });
      if (!opts.fixtureFor) throw new Error("startMcpRig needs either `fixtureFor` or `llmFor`");
      const fixturePath = path.join(transcriptsDir, opts.fixtureFor(task));
      const llm = createLlm("replay", { fixturePath, trace });
      return opts.wrapLlm ? opts.wrapLlm(llm, task) : llm;
    },
  });

  const dispatcher = createDispatcher(handle, { intervalMs: 25, backoffBaseMs: 10 });
  const engine = createEngine({
    db: handle.db,
    dispatcher,
    executors: { [executorKey("browser", "stub")]: StubExecutor, [executorKey("asset", "ai")]: executor },
    watchdogIntervalMs: 50,
    shutdownGraceMs: 2_000,
  });
  await engine.start();
  await dispatcher.start();

  return {
    handle,
    dispatcher,
    engine,
    blobs,
    gate,
    keyWrapper,
    secrets,
    stop: async () => {
      await dispatcher.stop();
      await engine.stop();
      // No fixture-site process to close, unlike `agent-support.ts` — an asset run has no
      // page, so nothing here ever launched one.
      await Promise.all([handle.close(), testBlobs.drop()]);
    },
  };
}

/** Inserts a `mcp_servers` row for `userId`, defaulting the config to the testkit fake stdio
 * server (`echo`/`imageStub`/`sleep`). `secretName` + `requireKeyEnv` together are the
 * credential test's fixture: the server demands `requireKeyEnv` be set, and `secretEnvVar`
 * (defaulted to the same name) is where `packages/mcp`'s client lands the redeemed secret. */
export async function insertFakeMcpServer(
  handle: MigratedTestDb,
  input: {
    userId: string;
    label?: string;
    secretName?: string;
    requireKeyEnv?: string;
  },
): Promise<string> {
  const label = input.label ?? "fake";
  const fakeOpts: FakeMcpServerOptions = input.requireKeyEnv ? { requireKeyEnv: input.requireKeyEnv } : {};
  const fake = fakeMcpServerConfig(fakeOpts);
  const id = newId("mcpserver");
  const row: NewMcpServer = {
    id,
    userId: input.userId,
    label,
    transport: "stdio",
    configJson: {
      command: fake.command,
      args: fake.args,
      env: fake.env,
      cwd: fake.cwd,
      ...(input.requireKeyEnv ? { secretEnvVar: input.requireKeyEnv } : {}),
    },
    secretName: input.secretName ?? null,
  };
  await handle.db.insert(mcpServers).values(row);
  return id;
}

export async function traceRowsFor(rig: McpRig, runId: string): Promise<TraceEntryRow[]> {
  return rig.handle.db.select().from(traceEntries).where(eq(traceEntries.runId, runId)).orderBy(asc(traceEntries.seq));
}

export async function waitForTraceRows(
  rig: McpRig,
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
