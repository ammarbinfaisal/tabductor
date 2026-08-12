import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { readAssetById } from "@tabductor/assets";
import { assets, type AssetRow } from "@tabductor/db";
import { seedWorkflow, type SeededWorkflow, type SeedSpec } from "@tabductor/engine";
import { eq } from "drizzle-orm";
import { eventsOfType, runsForTask, trigger, waitFor, waitForQuiet } from "./engine-support.js";
import { normalizePdfBytes, startLatexRig, type LatexRig } from "./latex-support.js";
import {
  fakeGramSubmissions,
  isValidPdfWithPages,
  startTwoKindRig,
  traceRowsFor,
  type FakeGramSubmission,
  type TwoKindRig,
} from "./two-kind-e2e-support.js";

/**
 * S5f — Phase 5's exit criterion. `fake-tweets` (cron, **browser**) → `tweet.detected` →
 * **asset** node calls the S5c fake MCP server's `imageStub`, writes a `.tex` (`assets.write`),
 * renders a PDF for real against S5e's renderer (`assets.render`), emits
 * `report.ready {asset_ref}` → **browser** node `page.upload`s it to `fake-gram`. Every
 * assertion below reads traces, events, the fake-gram admin log, or the asset store — never a
 * run's or executor's internal state — per the standing doctrine every prior system-test file
 * in this suite follows.
 *
 * The render is real, not stubbed (`latex-support.ts` builds the same sandbox image and starts
 * the same `apps/renderer` S5e's own suite does) — this file needs Docker for the same reason
 * `latex-renderer.test.ts` does, and shares one renderer process across every test below rather
 * than paying the cold Docker-image-build cost more than once.
 */

const REPORT_READY_SCHEMA = {
  type: "object",
  properties: { report: { $ref: "assetRef" } },
  required: ["report"],
  additionalProperties: false,
};

const TWEET_DETECTED_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" }, url: { type: "string" } },
  required: ["text", "url"],
  additionalProperties: false,
};

const GRAPH: Omit<SeedSpec, "userId" | "workflowId"> = {
  tasks: {
    Scrape: { mode: "ai", consumes: ["cron.fire"], emits: ["tweet.detected"] },
    Report: { kind: "asset", mode: "ai", consumes: ["tweet.detected"], emits: ["report.ready"] },
    Upload: { mode: "ai", consumes: ["report.ready"] },
  },
  events: {
    "tweet.detected": { schema: TWEET_DETECTED_SCHEMA },
    "report.ready": { schema: REPORT_READY_SCHEMA },
  },
};

type ReportRef = { asset_id: string; path: string; mime: string; sha256: string };

let latex: LatexRig | undefined;
let rigsToStop: TwoKindRig[] = [];

beforeAll(async () => {
  latex = await startLatexRig();
}, 300_000); // cold sandbox-image build can take several minutes; cached, later runs are instant.

afterAll(async () => {
  await latex?.stop();
});

afterEach(async () => {
  await Promise.all(rigsToStop.map((r) => r.stop()));
  rigsToStop = [];
});

async function newRig(): Promise<TwoKindRig> {
  const r = await startTwoKindRig({ rendererUrl: latex!.server.url });
  rigsToStop.push(r);
  return r;
}

/** Fires `cron.fire` on `Scrape` and waits for the whole three-task chain to settle. */
async function runOnceAndSettle(r: TwoKindRig, wf: SeededWorkflow): Promise<void> {
  await trigger(r, wf.taskIds.Scrape!, "cron.fire");
  await waitFor(
    "Scrape to succeed",
    async () => {
      const rows = await runsForTask(r, wf.taskIds.Scrape!);
      return rows.length > 0 && rows.every((row) => row.status === "succeeded") ? rows : false;
    },
    60_000,
  );
  await waitForQuiet(r, 60_000);
}

type FlowResult = {
  rig: TwoKindRig;
  wf: SeededWorkflow;
  tweetEvent: { text: string; url: string };
  reportRef: ReportRef;
  assetRow: AssetRow;
  pdf: Buffer;
  submissions: FakeGramSubmission[];
};

/** Drives the whole graph once, end to end, on a *fresh* rig, and returns everything the
 * assertions below need — shared by the "full flow" test and (called twice, on two
 * independent rigs) the replay-determinism test. */
async function runFullFlow(): Promise<FlowResult> {
  const r = await newRig();
  const wf = await seedWorkflow(r.handle.db, { ...GRAPH, userId: r.userId });
  await runOnceAndSettle(r, wf);

  const tweetEvents = await eventsOfType(r, "tweet.detected");
  expect(tweetEvents).toHaveLength(1);
  const tweetEvent = tweetEvents[0]!.packet as { text: string; url: string };

  const reportEvents = await eventsOfType(r, "report.ready");
  expect(reportEvents).toHaveLength(1);
  const reportRef = (reportEvents[0]!.packet as { report: ReportRef }).report;

  const [assetRow] = await r.handle.db.select().from(assets).where(eq(assets.id, reportRef.asset_id));
  if (!assetRow) throw new Error(`no asset row for ${reportRef.asset_id}`);
  const pdf = await r.blobs.get(assetRow.blobRef);

  const submissions = await fakeGramSubmissions(r);

  return { rig: r, wf, tweetEvent, reportRef, assetRow, pdf, submissions };
}

it("browser -> asset (MCP + LaTeX) -> browser: report.ready carries the real asset, the PDF is real, fake-gram got the same bytes", async () => {
  const { rig, wf, tweetEvent, reportRef, assetRow, pdf, submissions } = await runFullFlow();

  expect(tweetEvent).toEqual({ text: "first tweet", url: "/fake-tweets/status/t1" });

  // The emitted packet's asset_id names the asset the render actually produced — not a
  // plausible-looking value, the *same row* (id, path, mime, sha256 all agree).
  expect(assetRow.userId).toBe(rig.userId);
  expect(assetRow.path).toBe(reportRef.path);
  expect(assetRow.mime).toBe(reportRef.mime);
  expect(assetRow.sha256).toBe(reportRef.sha256);
  expect(reportRef.mime).toBe("application/pdf");

  // A valid, non-empty PDF — parses (header + at least one /Type/Page, live rendered, not a
  // fixture stand-in), not just "some bytes came back".
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(isValidPdfWithPages(pdf)).toBe(true);

  // fake-gram's recorded submission's sha256 equals the asset's sha256 — the bytes that left
  // the harness through page.upload are the bytes the store has, not merely "an upload happened".
  const uploads = submissions.filter((s) => s.kind === "upload");
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.fields.sha256).toBe(assetRow.sha256);
  expect(uploads[0]!.fields.filename).toBe(assetRow.path.split("/").pop());

  // The asset outlives the run: independently re-resolved via the exact read path
  // `page.upload` itself uses, well after every run in this flow has gone terminal — not
  // trace exhaust with a TTL, not scoped to whichever run wrote it.
  const reread = await readAssetById({ db: rig.handle.db, blobs: rig.blobs }, rig.userId, reportRef.asset_id);
  expect(reread?.sha256).toBe(assetRow.sha256);
  expect(reread?.bytes.equals(pdf)).toBe(true);

  // Traces, not (only) events: the asset node's own turn-by-turn `llm` trace rows show the
  // exact tool sequence the spec asks for — imageStub, then write, then render, then emit —
  // and the browser Upload run's `action` trace rows show a real `upload` action followed by
  // the submit click, proving the tool actually drove the page rather than a run that merely
  // "succeeded" for an unrelated reason.
  const reportRuns = await runsForTask(rig, wf.taskIds.Report!);
  expect(reportRuns).toHaveLength(1);
  const reportTrace = await traceRowsFor(rig, reportRuns[0]!.id);
  const reportToolSeq = reportTrace
    .filter((row) => row.kind === "llm")
    .map((row) => (row.payloadJson as { tool_calls: string[] }).tool_calls);
  expect(reportToolSeq).toEqual([
    ["mcp.fake.imageStub"],
    ["assets.write"],
    ["assets.render"],
    ["emit"],
    ["done"],
  ]);

  const uploadRuns = await runsForTask(rig, wf.taskIds.Upload!);
  expect(uploadRuns).toHaveLength(1);
  const uploadTrace = await traceRowsFor(rig, uploadRuns[0]!.id);
  const uploadAction = uploadTrace.find(
    (row) => row.kind === "action" && (row.payloadJson as { action?: string }).action === "upload",
  );
  expect(uploadAction).toBeDefined();
  expect((uploadAction!.payloadJson as { ok: boolean; size: number }).ok).toBe(true);
  expect((uploadAction!.payloadJson as { ok: boolean; size: number }).size).toBe(pdf.byteLength);
});

it("replay-determinism: two independent runs of the identical script produce equivalent packets, equivalent (normalized) PDF content, and one fake-gram submission each", async () => {
  const [first, second] = await Promise.all([runFullFlow(), runFullFlow()]);

  expect(second.tweetEvent).toEqual(first.tweetEvent);
  // `asset_id` is a fresh id per write (`newId("asset")`) — deliberately excluded, not
  // compared. `path`/`mime` are content, not identity, and must agree.
  expect(second.reportRef.path).toBe(first.reportRef.path);
  expect(second.reportRef.mime).toBe(first.reportRef.mime);
  expect(second.submissions.filter((s) => s.kind === "upload")).toHaveLength(1);
  expect(first.submissions.filter((s) => s.kind === "upload")).toHaveLength(1);

  // The raw sha256 is *expected* to differ between the two renders — S5e's own renderer is not
  // byte-stable across separate compiles even with `-Z deterministic-mode` (tectonic mints a
  // fresh document `/ID`, `apps/renderer/src/sandbox.ts`'s own comment on that flag) — so the
  // determinism claim is about *content*, checked the same way S5e's own happy-path test
  // checks it: normalize away the trailer, then compare.
  expect(normalizePdfBytes(first.pdf)).toEqual(normalizePdfBytes(second.pdf));
  const normalizedHash = (pdf: Buffer) => createHash("sha256").update(normalizePdfBytes(pdf)).digest("hex");
  expect(normalizedHash(second.pdf)).toBe(normalizedHash(first.pdf));

  // Within each run, the bytes fake-gram received still match that run's own (real, un-
  // normalized) asset sha256 — replay-determinism does not relax the byte-match property the
  // first test already proved for a single run.
  for (const flow of [first, second]) {
    const upload = flow.submissions.find((s) => s.kind === "upload")!;
    expect(upload.fields.sha256).toBe(flow.assetRow.sha256);
  }
});

it("re-fires the triggering cron: emitIfNew dedupe -> no double-render, no double-upload", async () => {
  const r = await newRig();
  const wf = await seedWorkflow(r.handle.db, { ...GRAPH, userId: r.userId });

  await runOnceAndSettle(r, wf);
  expect(await eventsOfType(r, "tweet.detected")).toHaveLength(1);
  expect(await eventsOfType(r, "report.ready")).toHaveLength(1);
  expect(await runsForTask(r, wf.taskIds.Report!)).toHaveLength(1);
  expect(await runsForTask(r, wf.taskIds.Upload!)).toHaveLength(1);
  expect((await fakeGramSubmissions(r)).filter((s) => s.kind === "upload")).toHaveLength(1);

  // Re-fire: Scrape runs a second time (replaying the identical script), but its own
  // `emitIfNew` dedupe on the tweet's permalink means `tweet.detected` does not publish a
  // second time — so nothing downstream ever sees a new trigger.
  await trigger(r, wf.taskIds.Scrape!, "cron.fire");
  await waitFor(
    "second Scrape run to succeed",
    async () => {
      const rows = await runsForTask(r, wf.taskIds.Scrape!);
      return rows.length === 2 && rows.every((row) => row.status === "succeeded") ? rows : false;
    },
    60_000,
  );
  await waitForQuiet(r, 60_000);

  expect(await eventsOfType(r, "tweet.detected")).toHaveLength(1); // still 1, not 2
  expect(await eventsOfType(r, "report.ready")).toHaveLength(1); // no second render
  expect(await runsForTask(r, wf.taskIds.Report!)).toHaveLength(1); // Report never re-ran
  expect(await runsForTask(r, wf.taskIds.Upload!)).toHaveLength(1); // Upload never re-ran
  expect((await fakeGramSubmissions(r)).filter((s) => s.kind === "upload")).toHaveLength(1); // exactly one upload
});
