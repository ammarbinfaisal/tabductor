import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  normalizeXlsxBytes,
  postRun,
  pythonHasModules,
  pythonIsAvailable,
  startPyrunnerRig,
  type PyRig,
} from "./python-support.js";

/**
 * The deliverable S5h exists for: a spreadsheet, produced twice, byte-stable.
 *
 * "Byte-stable" here means what it means for the PDF fixtures — stable *after* normalizing the
 * things a container format mints from the clock (see `normalizeXlsxBytes`, the `.xlsx`
 * analogue of `normalizePdfBytes`). What the test really guards is that nothing else varies:
 * dict and set ordering, float formatting, the chart's generated XML. That in turn is what
 * rests on `job.ts` spawning `-s -B` rather than `-I`.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "apps",
  "testkit",
  "fixtures",
  "python",
  "xlsx-report.py",
);

const TRIGGER = {
  rows: [
    { sku: "alpha", price: 12.5 },
    { sku: "beta", price: 7.25 },
    { sku: "alpha", price: 3.25 },
    { sku: "gamma", price: 99.99 },
  ],
};

let rig: PyRig;
let ready = false;

beforeAll(async () => {
  ready = (await pythonIsAvailable()) && (await pythonHasModules(["xlsxwriter"]));
  if (ready) rig = await startPyrunnerRig({ maxFileBytes: 4 * 1024 * 1024 });
}, 60_000);

afterAll(async () => {
  await rig?.stop();
});

it("produces the same workbook twice from the same trigger", async () => {
  if (!ready) {
    // Loud, never silent, and never by asserting something weaker instead.
    console.warn("SKIPPED (needs python3 with xlsxwriter): python-xlsx");
    return;
  }
  const code = readFileSync(FIXTURE, "utf8");
  const [first, second] = await Promise.all([
    postRun(rig, { code, trigger: TRIGGER, sourceDateEpoch: 1_700_000_000 }),
    postRun(rig, { code, trigger: TRIGGER, sourceDateEpoch: 1_700_000_000 }),
  ]);
  expect(first.ok, JSON.stringify(first).slice(0, 400)).toBe(true);
  expect(second.ok).toBe(true);

  const bytesOf = (r: typeof first): Buffer => {
    const files = r.files as { path: string; contentBase64: string }[];
    expect(files.map((f) => f.path)).toEqual(["reports/pricing.xlsx"]);
    return Buffer.from(files[0]!.contentBase64, "base64");
  };

  const a = bytesOf(first);
  // A real workbook, not an empty shell — the normalizer would happily compare two of those.
  expect(a.subarray(0, 2).toString()).toBe("PK");
  expect(normalizeXlsxBytes(a)).toContain("xl/worksheets/sheet1.xml");
  expect(normalizeXlsxBytes(a)).toBe(normalizeXlsxBytes(bytesOf(second)));

  // And the emit names the file it wrote, for the executor to resolve.
  expect(JSON.parse((first.emitsJsonl as string).split("\n")[0]!)).toMatchObject({
    type: "report.ready",
    packet: { report: { $asset: "reports/pricing.xlsx" }, skus: 3 },
  });
}, 120_000);
