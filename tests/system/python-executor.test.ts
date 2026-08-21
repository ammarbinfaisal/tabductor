import { afterEach, expect, it } from "vitest";
import { assets, assetVersions, assetWriteGrants, events } from "@tabductor/db";
import { executorKey, seedWorkflow, StubExecutor, triggerTask, type GraphCode, type GraphRuntime } from "@tabductor/engine";
import { createPythonExecutor } from "@tabductor/engine/python";
import type { PyrunClient, PyrunOutcome } from "../../packages/engine/src/pyrun-client.js";
import { createTestBlobStore, type TestBlobStore } from "@tabductor/testkit";
import { eq } from "drizzle-orm";
import { runsForTask, startRig, waitForQuiet, type Rig } from "./engine-support.js";

/**
 * The host boundary, driven with a **fake** `PyrunClient` — no Python, no HTTP, so this is the
 * fast feedback loop for every rule that protects the asset store.
 *
 * The point of the file: `apps/pyrunner` is a network peer, and everything it returns is
 * untrusted input. Not because the operator's own program is hostile — after the S5h reshape
 * there is no tenant to defend against — but because this process holds the store's write
 * capability, and a filename is a filename whoever wrote it. Every one of these cases is a
 * rejection that has to happen *here*, on the host, whatever the runner did or did not do.
 */

const CODE: GraphCode = { language: "python", source: "print('x')" };
const RUNTIME: GraphRuntime = {
  image: "py-2026.08",
  packages: [],
  inputs: { assets: [], tables: [] },
};

/** Returns whatever the test says pyrunner returned, without running anything. */
function fakeClient(outcome: PyrunOutcome): PyrunClient {
  return { run: async () => outcome };
}

function okWith(files: { path: string; bytes: Buffer }[], emitsJsonl = ""): PyrunOutcome {
  return {
    ok: true,
    durationMs: 5,
    files,
    emitsJsonl,
    stdout: "",
    stderr: "",
    skipped: { nonRegular: 0 },
  };
}

let rig: Rig | undefined;
let blobs: TestBlobStore | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
  await blobs?.drop();
  blobs = undefined;
});

/** One python task, triggered once, run to completion. Returns the run row and the rig. */

/**
 * The executor needs the rig's db, which only exists after `startRig` — so the rig is built
 * first with a placeholder registry and the executor registered against the live handle.
 */
async function startPythonRig(
  outcome: PyrunOutcome,
  task: { grantGlob?: string; emits?: string[]; retry?: { max: number; backoff_ms?: number } } = {},
): Promise<{ taskId: string; rigRef: Rig }> {
  blobs = await createTestBlobStore();
  const store = blobs.store;
  const client: PyrunClient = fakeClient(outcome);
  rig = await startRig({
    executors: {
      [executorKey("browser", "stub")]: StubExecutor,
      [executorKey("asset", "python")]: {
        execute: (handle) =>
          createPythonExecutor({ db: rig!.handle.db, blobs: store, pyrun: client }).execute(handle),
      },
    },
  });

  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Report: {
        kind: "asset",
        mode: "python",
        code: CODE,
        runtime: RUNTIME,
        ...(task.emits ? { emits: task.emits } : {}),
        ...(task.retry ? { retry: task.retry } : {}),
      },
    },
  });
  const taskId = wf.taskIds.Report!;
  if (task.grantGlob) {
    await rig.handle.db.insert(assetWriteGrants).values({ taskId, pathGlob: task.grantGlob });
  }
  await triggerTask(rig.handle.db, { taskId });
  await waitForQuiet(rig);
  return { taskId, rigRef: rig };
}

it("writes a returned file into the asset store and succeeds", async () => {
  const { taskId } = await startPythonRig(okWith([{ path: "reports/out.txt", bytes: Buffer.from("hello") }]));
  const runs = await runsForTask(rig!, taskId);
  expect(runs[0]!.status).toBe("succeeded");

  const rows = await rig!.handle.db.select().from(assets);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.path).toBe("/reports/out.txt");
  const versions = await rig!.handle.db.select().from(assetVersions).where(eq(assetVersions.assetId, rows[0]!.id));
  expect(versions).toHaveLength(1);
});

it("rejects a traversal path host-side, writing nothing", async () => {
  const { taskId } = await startPythonRig(okWith([{ path: "../../etc/passwd", bytes: Buffer.from("root:x:0:0") }]));
  const runs = await runsForTask(rig!, taskId);
  expect(runs[0]!.status).toBe("failed");
  expect(runs[0]!.error).toContain("invalid output path");
  expect(await rig!.handle.db.select().from(assets)).toHaveLength(0);
});

/**
 * The two-pass proof. A response mixing a granted file with an ungranted one must write
 * *neither* — validating as it writes would leave the first one behind under a `report.ready`
 * that never fired.
 */
it("rejects the whole batch when one path is outside the task's grant", async () => {
  const { taskId } = await startPythonRig(
    okWith([
      { path: "reports/allowed.txt", bytes: Buffer.from("fine") },
      { path: "secrets/stolen.txt", bytes: Buffer.from("nope") },
    ]),
    { grantGlob: "/reports/**" },
  );
  const runs = await runsForTask(rig!, taskId);
  expect(runs[0]!.status).toBe("failed");
  // Named the *ungranted* file, so the grant is what rejected it — not the glob
  // accidentally excluding both.
  expect(runs[0]!.error).toContain("/secrets/stolen.txt");
  // And the granted sibling is absent, which is the whole point: validate all, then write.
  expect(await rig!.handle.db.select().from(assets)).toHaveLength(0);
});

it("rejects two outputs that resolve to the same asset path", async () => {
  const { taskId } = await startPythonRig(
    okWith([
      { path: "reports/dup.txt", bytes: Buffer.from("a") },
      { path: "./reports/dup.txt", bytes: Buffer.from("b") },
    ]),
  );
  const runs = await runsForTask(rig!, taskId);
  expect(runs[0]!.status).toBe("failed");
  expect(runs[0]!.error).toContain("same asset path");
  expect(await rig!.handle.db.select().from(assets)).toHaveLength(0);
});

it("substitutes $asset with the real ref, and the event points at the stored bytes", async () => {
  const emit = JSON.stringify({
    type: "report.ready",
    packet: { report: { $asset: "reports/out.txt" } },
  });
  const { taskId } = await startPythonRig(
    okWith([{ path: "reports/out.txt", bytes: Buffer.from("payload") }], emit),
    { emits: ["report.ready"] },
  );
  expect((await runsForTask(rig!, taskId))[0]!.status).toBe("succeeded");

  const [event] = await rig!.handle.db.select().from(events).where(eq(events.type, "report.ready"));
  const ref = (event!.packet as { report: { asset_id: string; sha256: string; path: string } }).report;
  const [row] = await rig!.handle.db.select().from(assets).where(eq(assets.id, ref.asset_id));
  expect(row).toBeDefined();
  expect(row!.sha256).toBe(ref.sha256);
  expect(ref.path).toBe("/reports/out.txt");
});

it("fails the run when $asset names an output the job did not produce", async () => {
  const emit = JSON.stringify({ type: "report.ready", packet: { report: { $asset: "reports/ghost.txt" } } });
  const { taskId } = await startPythonRig(
    okWith([{ path: "reports/out.txt", bytes: Buffer.from("payload") }], emit),
    { emits: ["report.ready"] },
  );
  const runs = await runsForTask(rig!, taskId);
  expect(runs[0]!.status).toBe("failed");
  expect(runs[0]!.error).toContain("did not produce");
  expect(await rig!.handle.db.select().from(events).where(eq(events.type, "report.ready"))).toHaveLength(0);
});

it("fails the run on a malformed emits.jsonl line, publishing nothing", async () => {
  const { taskId } = await startPythonRig(okWith([], "{not json at all"), { emits: ["report.ready"] });
  const runs = await runsForTask(rig!, taskId);
  expect(runs[0]!.status).toBe("failed");
  expect(runs[0]!.error).toContain("malformed emits.jsonl line 1");
  expect(await rig!.handle.db.select().from(events).where(eq(events.type, "report.ready"))).toHaveLength(0);
});

/**
 * These two are a pair, and the second is why the first means something: `permanent` has to be
 * a *choice* the executor makes per outcome, not the only behaviour it has.
 */
it("a wall-clock kill fails permanently — no retry row, even with a retry policy", async () => {
  const { taskId } = await startPythonRig(
    { ok: false, kind: "killed", reason: "wall_clock", durationMs: 1_000 },
    { retry: { max: 2, backoff_ms: 10 } },
  );
  const runs = await runsForTask(rig!, taskId);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status).toBe("failed");
  expect(runs[0]!.error).toContain("wall clock");
});

it("a program error is retryable — the policy produces a second run row", async () => {
  const { taskId } = await startPythonRig(
    { ok: false, kind: "program_error", exitCode: 1, stderr: "ValueError: boom", durationMs: 5 },
    { retry: { max: 1, backoff_ms: 10 } },
  );
  const runs = await runsForTask(rig!, taskId);
  expect(runs.length).toBeGreaterThan(1);
  expect(runs[0]!.error).toContain("ValueError: boom");
});
