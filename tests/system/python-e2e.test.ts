import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { assets } from "@tabductor/db";
import { readAssetById } from "@tabductor/assets";
import {
  executorKey,
  seedWorkflow,
  StubExecutor,
  triggerTask,
  type GraphRuntime,
} from "@tabductor/engine";
import { createPythonExecutor, createPyrunClient } from "@tabductor/engine/python";
import { createTestBlobStore, type TestBlobStore } from "@tabductor/testkit";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { eventsOfType, runsForTask, startRig, waitForQuiet, type Rig } from "./engine-support.js";
import { pythonIsAvailable, startPyrunnerRig, type PyRig } from "./python-support.js";

/**
 * The whole chain, with a real Python process in the middle: a browser-kind stub emits rows, a
 * `mode=python` asset node turns them into a file, and a third node consumes the event and
 * reads the bytes back out of the asset store.
 *
 * The program writes a CSV rather than an `.xlsx` so this runs anywhere `python3` does — the
 * spreadsheet path and its byte-stability are `python-xlsx.test.ts`'s job. What is under test
 * here is the seam: `$asset` resolving to a real ref, the packet validating against its
 * compiled schema, and the bytes a downstream node fetches being the bytes the program wrote.
 */

const RUNTIME: GraphRuntime = {
  image: "py-2026.08",
  packages: [],
  inputs: { assets: [], tables: [] },
};

const PROGRAM = [
  "import csv, json, pathlib",
  "rows = json.loads(pathlib.Path('in/trigger.json').read_text())['rows']",
  "pathlib.Path('out/files/reports').mkdir(parents=True, exist_ok=True)",
  "with open('out/files/reports/pricing.csv', 'w', newline='') as f:",
  "    w = csv.writer(f)",
  "    w.writerow(['sku', 'price'])",
  "    for r in sorted(rows, key=lambda r: r['sku']):",
  "        w.writerow([r['sku'], r['price']])",
  "with open('out/emits.jsonl', 'w') as f:",
  "    f.write(json.dumps({",
  "        'type': 'report.ready',",
  "        'packet': {'report': {'$asset': 'reports/pricing.csv'}, 'rows': len(rows)},",
  "    }) + '\\n')",
].join("\n");

let pyRig: PyRig;
let ready = false;
let rig: Rig | undefined;
let blobs: TestBlobStore | undefined;

beforeAll(async () => {
  ready = await pythonIsAvailable();
  if (ready) pyRig = await startPyrunnerRig();
}, 60_000);

afterAll(async () => {
  await pyRig?.stop();
});

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
  await blobs?.drop();
  blobs = undefined;
});

it("stub -> python -> asset -> downstream: the event points at the bytes the program wrote", async () => {
  if (!ready) {
    console.warn("SKIPPED (no python3 on PATH): python-e2e");
    return;
  }
  blobs = await createTestBlobStore();
  const store = blobs.store;
  const pyrun = createPyrunClient({ url: pyRig.server.url });

  rig = await startRig({
    executors: {
      [executorKey("browser", "stub")]: StubExecutor,
      [executorKey("asset", "python")]: {
        execute: (handle) => createPythonExecutor({ db: rig!.handle.db, blobs: store, pyrun }).execute(handle),
      },
    },
  });
  const db = rig.handle.db;

  const wf = await seedWorkflow(db, {
    tasks: {
      Scrape: {
        stub: {
          emits: [
            {
              type: "pricing.rows",
              packet: {
                rows: [
                  { sku: "beta", price: 7.25 },
                  { sku: "alpha", price: 12.5 },
                ],
              },
            },
          ],
        },
        emits: ["pricing.rows"],
      },
      Report: {
        kind: "asset",
        mode: "python",
        code: { language: "python", source: PROGRAM },
        runtime: RUNTIME,
        consumes: ["pricing.rows"],
        emits: ["report.ready"],
      },
      Notify: { consumes: ["report.ready"] },
    },
  });

  await triggerTask(db, { taskId: wf.taskIds.Scrape! });
  await waitForQuiet(rig);

  for (const name of ["Scrape", "Report", "Notify"] as const) {
    const runs = await runsForTask(rig, wf.taskIds[name]!);
    expect(runs, `${name} should have run once`).toHaveLength(1);
    expect(runs[0]!.status, `${name} run status`).toBe("succeeded");
  }

  const ready$ = await eventsOfType(rig, "report.ready");
  expect(ready$).toHaveLength(1);
  const packet = ready$[0]!.packet as {
    report: { asset_id: string; path: string; mime: string; sha256: string };
    rows: number;
  };
  expect(packet.rows).toBe(2);
  expect(packet.report.path).toBe("/reports/pricing.csv");
  expect(packet.report.mime).toBe("text/csv");

  // The bytes a downstream node would fetch are the bytes the program wrote — and the digest
  // in the packet is the digest of those bytes, not something minted alongside them.
  const [row] = await db.select().from(assets).where(eq(assets.id, packet.report.asset_id));
  expect(row).toBeDefined();
  const resolved = await readAssetById({ db, blobs: store }, "user_test", packet.report.asset_id);
  expect(resolved).toBeDefined();
  const text = resolved!.bytes.toString("utf8");
  expect(text).toBe("sku,price\r\nalpha,12.5\r\nbeta,7.25\r\n");
  expect(createHash("sha256").update(resolved!.bytes).digest("hex")).toBe(packet.report.sha256);
}, 120_000);
