import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { buildPythonTool, createAssetExecutor, createLlm } from "@tabductor/agent";
import { readAssetById } from "@tabductor/assets";
import { newId } from "@tabductor/core";
import { assets, assetVersions, assetWriteGrants, traceEntries } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { executorKey, seedWorkflow, StubExecutor, triggerTask } from "@tabductor/engine";
import { createPyrunClient, type PyrunClient, type PyrunOutcome } from "@tabductor/engine/python";
import { AllowAllGate } from "@tabductor/policy";
import { createTestBlobStore, type TestBlobStore } from "@tabductor/testkit";
import { asc, eq } from "drizzle-orm";
import { runsForTask, startRig, waitForQuiet, type Rig } from "./engine-support.js";
import { pythonIsAvailable, startPyrunnerRig, type PyRig } from "./python-support.js";

/**
 * `python.run` — the asset node's compute tool, which replaced `mode=python`.
 *
 * Three layers, each tested where it lives:
 *
 * 1. **The host boundary**, with a *fake* `PyrunClient` (no Python, no HTTP): everything the
 *    runner returns is untrusted, so every rejection that protects the asset store has to
 *    happen here whatever the runner did. The same corpus S5h ran against the old executor.
 * 2. **The round trip**, with the real `apps/pyrunner` in-process: a program writes a CSV,
 *    the tool returns an asset ref whose digest is the digest of those bytes.
 * 3. **The loop**, with a replay transcript: an ordinary `(asset, ai)` run calls `python.run`
 *    like any other tool, and the file it wrote is in the store when the run is done.
 */

const TRANSCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "transcripts");

/** Returns whatever the test says pyrunner returned, without running anything. */
function fakeClient(outcome: PyrunOutcome): PyrunClient {
  return { run: async () => outcome };
}

function okWith(files: { path: string; bytes: Buffer }[], emitsJsonl = ""): PyrunOutcome {
  return { ok: true, durationMs: 5, files, emitsJsonl, stdout: "", stderr: "", skipped: { nonRegular: 0 } };
}

const PROGRAM = [
  "import csv, os",
  "os.makedirs('out/files/reports', exist_ok=True)",
  "rows = [{'sku': 'beta', 'price': 7.25}, {'sku': 'alpha', 'price': 12.5}]",
  "with open('out/files/reports/pricing.csv', 'w', newline='') as f:",
  "    w = csv.writer(f)",
  "    w.writerow(['sku', 'price'])",
  "    for r in sorted(rows, key=lambda r: r['sku']):",
  "        w.writerow([r['sku'], r['price']])",
  "print('wrote', len(rows), 'rows')",
].join("\n");

let handle: MigratedTestDb | undefined;
let blobs: TestBlobStore | undefined;
let rig: Rig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
  await handle?.close();
  handle = undefined;
  await blobs?.drop();
  blobs = undefined;
});

/** A published asset task to run the tool on behalf of, and the deps the tool takes. */
async function toolDeps(grantGlob?: string) {
  handle = await createMigratedTestDb();
  blobs = await createTestBlobStore();
  const wf = await seedWorkflow(handle.db, { tasks: { Report: { kind: "asset", mode: "ai" } } });
  const taskId = wf.taskIds.Report!;
  if (grantGlob) await handle.db.insert(assetWriteGrants).values({ taskId, pathGlob: grantGlob });
  return { db: handle.db, blobs: blobs.store, userId: "user_test", taskId, runId: newId("run") };
}

// -- 1. the host boundary ---------------------------------------------------------------------

it("writes a returned file into the asset store and returns its ref", async () => {
  const deps = await toolDeps();
  const tool = buildPythonTool({ assets: deps, pyrun: fakeClient(okWith([{ path: "reports/out.txt", bytes: Buffer.from("hello") }])) });

  const result = await tool.execute({ code: "print('x')" });
  expect(result.ok).toBe(true);
  expect(String((result as { value: unknown }).value)).toContain("/reports/out.txt");

  const rows = await deps.db.select().from(assets);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.path).toBe("/reports/out.txt");
  expect(await deps.db.select().from(assetVersions).where(eq(assetVersions.assetId, rows[0]!.id))).toHaveLength(1);
});

it("rejects a traversal path host-side, writing nothing", async () => {
  const deps = await toolDeps();
  const tool = buildPythonTool({ assets: deps, pyrun: fakeClient(okWith([{ path: "../../etc/passwd", bytes: Buffer.from("root:x") }])) });
  const result = await tool.execute({ code: "print('x')" });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("invalid output path") });
  expect(await deps.db.select().from(assets)).toHaveLength(0);
});

/** The two-pass proof: a batch mixing a granted file with an ungranted one writes *neither*. */
it("rejects the whole batch when one path is outside the task's grant", async () => {
  const deps = await toolDeps("/reports/**");
  const tool = buildPythonTool({
    assets: deps,
    pyrun: fakeClient(
      okWith([
        { path: "reports/allowed.txt", bytes: Buffer.from("fine") },
        { path: "secrets/stolen.txt", bytes: Buffer.from("nope") },
      ]),
    ),
  });
  const result = await tool.execute({ code: "print('x')" });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("write outside this task's granted paths") });
  expect(await deps.db.select().from(assets)).toHaveLength(0);
});

it.each([
  ["a program error", { ok: false, kind: "program_error", exitCode: 1, stderr: "Traceback: boom", durationMs: 3 } as PyrunOutcome, "python exited 1"],
  ["a wall-clock kill", { ok: false, kind: "killed", reason: "wall_clock", durationMs: 3 } as PyrunOutcome, "wall clock"],
  ["an output cap", { ok: false, kind: "output_cap", limit: "maxOutputBytes", durationMs: 3 } as PyrunOutcome, "output cap exceeded"],
  ["an unreachable runner", { ok: false, kind: "unavailable", log: "ECONNREFUSED" } as PyrunOutcome, "pyrunner unavailable"],
])("reports %s as a tool error, not a thrown run", async (_label, outcome, needle) => {
  const deps = await toolDeps();
  const tool = buildPythonTool({ assets: deps, pyrun: fakeClient(outcome) });
  const result = await tool.execute({ code: "print('x')" });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining(needle) });
});

/** The tool is always on the registry; without a client it fails closed and says why. */
it("without a configured runner the tool exists and reports itself unavailable", async () => {
  const deps = await toolDeps();
  const tool = buildPythonTool({ assets: deps });
  expect(tool.name).toBe("python.run");
  expect(await tool.execute({ code: "print('x')" })).toMatchObject({ ok: false, error: expect.stringContaining("PYRUNNER_URL") });
});

it("caps a requested wall clock at the task's limit", async () => {
  const deps = await toolDeps();
  let seen: number | undefined;
  const pyrun: PyrunClient = {
    run: async (job) => {
      seen = job.wallClockMs;
      return okWith([]);
    },
  };
  const tool = buildPythonTool({ assets: deps, pyrun, maxWallClockMs: 2_000 });
  await tool.execute({ code: "print('x')", wall_clock_ms: 60_000 });
  expect(seen).toBe(2_000);
});

// -- 2. the round trip, with the real runner --------------------------------------------------

let pyRig: PyRig | undefined;
let ready = false;

beforeAll(async () => {
  ready = await pythonIsAvailable();
  if (ready) pyRig = await startPyrunnerRig();
}, 60_000);

afterAll(async () => {
  await pyRig?.stop();
});

it("a real program's output is an asset whose digest is the digest of its bytes", async () => {
  if (!ready) {
    console.warn("SKIPPED (no python3 on PATH): python-tool round trip");
    return;
  }
  const deps = await toolDeps();
  const tool = buildPythonTool({ assets: deps, pyrun: createPyrunClient({ url: pyRig!.server.url }) });

  const result = await tool.execute({ code: PROGRAM });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const text = String((result as { value: string }).value);
  expect(text).toContain("wrote 2 rows");

  const [row] = await deps.db.select().from(assets).where(eq(assets.path, "/reports/pricing.csv"));
  expect(row).toBeDefined();
  const resolved = await readAssetById({ db: deps.db, blobs: deps.blobs }, "user_test", row!.id);
  expect(resolved!.bytes.toString("utf8")).toBe("sku,price\r\nalpha,12.5\r\nbeta,7.25\r\n");
  expect(text).toContain(createHash("sha256").update(resolved!.bytes).digest("hex"));
}, 60_000);

// -- 3. the loop: an ordinary asset run calls python.run like any other tool ------------------

it("an (asset, ai) run calls python.run through the agent loop and the file lands in the store", async () => {
  if (!ready) {
    console.warn("SKIPPED (no python3 on PATH): python-tool loop");
    return;
  }
  blobs = await createTestBlobStore();
  const store = blobs.store;
  const pyrun = createPyrunClient({ url: pyRig!.server.url });
  rig = await startRig({
    executors: {
      [executorKey("browser", "stub")]: StubExecutor,
      [executorKey("asset", "ai")]: {
        execute: (h) =>
          createAssetExecutor({
            gate: new AllowAllGate(),
            blobs: store,
            db: rig!.handle.db,
            pyrun,
            llmFor: ({ trace }) => createLlm("replay", { fixturePath: path.join(TRANSCRIPTS, "python-run.jsonl"), trace }),
          }).execute(h),
      },
    },
  });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, {
    tasks: { Report: { kind: "asset", mode: "ai", prompt: "Produce the pricing CSV with Python." } },
  });
  const taskId = wf.taskIds.Report!;

  await triggerTask(db, { taskId });
  await waitForQuiet(rig);

  const runs = await runsForTask(rig, taskId);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status, runs[0]!.error ?? "").toBe("succeeded");

  const [row] = await db.select().from(assets).where(eq(assets.path, "/reports/pricing.csv"));
  expect(row).toBeDefined();

  // The tool call is in the trace like any other (`llm` rows record tool calls by name): the
  // run's own record says Python ran.
  const entries = await db.select().from(traceEntries).where(eq(traceEntries.runId, runs[0]!.id)).orderBy(asc(traceEntries.seq));
  const calls = entries.filter((e) => e.kind === "llm").flatMap((e) => (e.payloadJson as { tool_calls?: string[] }).tool_calls ?? []);
  expect(calls).toContain("python.run");
}, 120_000);
