import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { createAgentExecutor, createAssetExecutor, createLlm, type Llm } from "@tabductor/agent";
import { createRenderClient, type RenderClient } from "@tabductor/assets";
import {
  createEndpointPool,
  playwrightDriver,
  type BlobStore,
  type EndpointPool,
  type TraceRecorder,
} from "@tabductor/browser";
import { createDispatcher, type Dispatcher } from "@tabductor/bus";
import { newId } from "@tabductor/core";
import { cdpEndpoints, events, traceEntries, type Db, type TaskRow, type TraceEntryRow } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createEngine, executorKey, type Engine } from "@tabductor/engine";
import { AllowAllGate, type PolicyGate } from "@tabductor/policy";
import { createTestBlobStore, launchChrome, startFixtures, type Chrome, type Fixtures } from "@tabductor/testkit";
import { asc, desc, eq } from "drizzle-orm";
import { insertFakeMcpServer } from "./mcp-support.js";

/**
 * Rig for `two-kind-e2e.test.ts` (S5f, Phase 5's exit criterion) — the one place in this
 * subphase that runs `AgentExecutor` (browser) and `createAssetExecutor` (asset) side by side
 * on one engine, because the scenario needs both: `agent-support.ts` (S4b) never registers an
 * asset executor, `mcp-support.ts` (S5c) never launches Chrome or the fixture sites. Neither
 * existing rig composes without changing that file's own single-kind contract, so this one
 * exists instead of bending either.
 *
 * The renderer (`apps/renderer`, S5e) is **not** started here — it is Docker-backed and slow
 * to cold-build, so the test file starts one via `latex-support.ts`'s `startLatexRig()` once
 * in `beforeAll` and this rig only ever receives its URL, shared across as many independent
 * rigs (`startTwoKindRig` calls) as one test file needs.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const transcriptsDir = path.join(here, "fixtures", "transcripts");

export const SCRAPE_TRANSCRIPT = "two-kind-scrape.jsonl";
export const REPORT_TRANSCRIPT = "two-kind-report.jsonl";
export const UPLOAD_TRANSCRIPT = "two-kind-upload.jsonl";

export type TwoKindRig = {
  handle: MigratedTestDb;
  dispatcher: Dispatcher;
  engine: Engine;
  pool: EndpointPool;
  chrome: Chrome;
  fx: Fixtures;
  blobs: BlobStore;
  endpointId: string;
  gate: PolicyGate;
  userId: string;
  stop: () => Promise<void>;
};

export type StartTwoKindRigOptions = {
  /** `apps/renderer`'s URL — shared across the whole test file (see the file doc comment). */
  rendererUrl: string;
  userId?: string;
};

/** `__FX_URL__`, `agent-support.ts`'s own convention (S4b) — the fixture server's origin is a
 * random port chosen at `startFixtures()` time and cannot be baked into a file `git` tracks. */
function renderScrapeTranscript(fxUrl: string, scratchDir: string): string {
  const raw = readFileSync(path.join(transcriptsDir, SCRAPE_TRANSCRIPT), "utf8");
  const out = path.join(scratchDir, SCRAPE_TRANSCRIPT);
  writeFileSync(out, raw.replaceAll("__FX_URL__", fxUrl));
  return out;
}

/**
 * The Upload task's transcript references the *real* asset ref `Report`'s run produced —
 * `__ASSET_ID__`/`__ASSET_PATH__`/`__ASSET_MIME__`/`__ASSET_SHA256__` tokens, resolved from the
 * `report.ready` event this rig's own DB already holds by the time Upload's run is dispatched
 * (dispatch only creates that run *after* the triggering event is published). Not knowable at
 * rig-construction time (S5e's renderer is not byte-stable across renders, and `asset_id` is a
 * fresh id every write) — resolved lazily, once, on the first `Llm.complete` call for that run.
 */
async function reportAssetRef(
  db: Db,
): Promise<{ asset_id: string; path: string; mime: string; sha256: string }> {
  const rows = await db
    .select({ packet: events.packet })
    .from(events)
    .where(eq(events.type, "report.ready"))
    .orderBy(desc(events.occurredAt))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("no report.ready event published yet — Upload dispatched too early");
  const packet = row.packet as { report: { asset_id: string; path: string; mime: string; sha256: string } };
  return packet.report;
}

async function renderUploadTranscript(db: Db, fxUrl: string, scratchDir: string): Promise<string> {
  const ref = await reportAssetRef(db);
  const raw = readFileSync(path.join(transcriptsDir, UPLOAD_TRANSCRIPT), "utf8");
  const substituted = raw
    .replaceAll("__FX_URL__", fxUrl)
    .replaceAll("__ASSET_ID__", ref.asset_id)
    .replaceAll("__ASSET_PATH__", ref.path)
    .replaceAll("__ASSET_MIME__", ref.mime)
    .replaceAll("__ASSET_SHA256__", ref.sha256);
  // Unique per resolution (not cached by name, unlike the Scrape transcript): a second run of
  // this same task (the replay-determinism/re-fire tests) must re-read the DB's *current*
  // `report.ready`, never reuse a stale substitution from an earlier run in the same rig.
  const out = path.join(scratchDir, `${UPLOAD_TRANSCRIPT}.${newId("run")}`);
  writeFileSync(out, substituted);
  return out;
}

/** Wraps `createLlm("replay", ...)` behind a `Llm` whose fixture path resolves lazily, on the
 * first `complete()` call — `AgentExecutorDeps.llmFor` must return synchronously, but Upload's
 * fixture path needs an async DB read first (see `renderUploadTranscript`'s doc comment). */
function lazyReplayLlm(resolveFixturePath: () => Promise<string>, trace: TraceRecorder): Llm {
  let inner: Llm | undefined;
  return {
    async complete(req) {
      inner ??= createLlm("replay", { fixturePath: await resolveFixturePath(), trace });
      return inner.complete(req);
    },
  };
}

/** The `<<<UNTRUSTED_DATA ...>>>` block `untrustedBlock` (`packages/agent/src/tools.ts`) wraps
 * every tool-results turn in: header, description, `JSON.stringify(data)`, footer — one line
 * each (`.join("\n")`), so the JSON payload is always line index 2. */
function untrustedBlockJson(content: string): unknown[] | undefined {
  const line = content.split("\n")[2];
  if (line === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type ToolCallResultShape = { name: string; result: { ok: true; value: unknown } | { ok: false; error: string } };

/**
 * Splices the *real* `assets.render` output into the Report transcript's `emit report.ready`
 * turn. The transcript (`two-kind-report.jsonl`) cannot hardcode `asset_id`/`sha256` — a fresh
 * `asset_id` per `assets.write`/`putVersion` call, and S5e's renderer is not byte-stable across
 * renders (its own `normalizePdfBytes` precedent exists exactly because tectonic mints a fresh
 * `/ID` per compile) — so it ships a placeholder and this wrapper reads the real values back
 * out of the conversation the loop itself already built: `req.messages`'s last entry, for the
 * turn immediately after `assets.render`, is always that turn's own
 * `untrustedBlock("tool results", ...)` (`loop.ts`), which already carries the tool's real JSON
 * output verbatim. A live model reads that identical text and copies the values by hand; this
 * is the deterministic stand-in for that one copy — not a new mechanism the loop doesn't
 * already expose, and not a value this file invents.
 */
function spliceRealAssetRef(inner: Llm): Llm {
  return {
    async complete(req) {
      const res = await inner.complete(req);
      const emitCall = res.toolCalls.find(
        (c) => c.name === "emit" && (c.args as { type?: unknown }).type === "report.ready",
      );
      if (!emitCall) return res;

      const last = req.messages[req.messages.length - 1];
      const results = last ? untrustedBlockJson(last.content) : undefined;
      const renderEntry = results?.find(
        (r): r is ToolCallResultShape => typeof r === "object" && r !== null && (r as { name?: unknown }).name === "assets.render",
      );
      if (!renderEntry || !renderEntry.result.ok) return res; // nothing to splice — leave the scripted args alone

      const { asset_id, path, mime, sha256 } = renderEntry.result.value as {
        asset_id: string;
        path: string;
        mime: string;
        sha256: string;
      };
      const splicedArgs = { ...emitCall.args, packet: { report: { asset_id, path, mime, sha256 } } };
      return {
        ...res,
        toolCalls: res.toolCalls.map((c) => (c === emitCall ? { ...c, args: splicedArgs } : c)),
      };
    },
  };
}

export async function startTwoKindRig(opts: StartTwoKindRigOptions): Promise<TwoKindRig> {
  const userId = opts.userId ?? newId("user");
  const [handle, chrome, fx, testBlobs] = await Promise.all([
    createMigratedTestDb(),
    launchChrome(),
    startFixtures(),
    createTestBlobStore(),
  ]);
  const blobs = testBlobs.store;
  const gate = new AllowAllGate({ navAllowlist: ["127.0.0.1"] });

  const endpointId = newId("endpoint");
  await handle.db.insert(cdpEndpoints).values({ id: endpointId, wsUrl: chrome.wsUrl });
  await insertFakeMcpServer(handle, { userId });

  const pool = createEndpointPool({ db: handle.db, driver: playwrightDriver });
  const render: RenderClient = createRenderClient({ url: opts.rendererUrl });

  const scratchDir = mkdtempSync(path.join(tmpdir(), "tabductor-two-kind-transcripts-"));

  const browserExecutor = createAgentExecutor({
    pool,
    gate,
    blobs,
    db: handle.db,
    endpointFor: async () => endpointId,
    llmFor: ({ trace, task }) => {
      if (task.name === "Upload") {
        return lazyReplayLlm(() => renderUploadTranscript(handle.db, fx.url, scratchDir), trace);
      }
      const fixturePath = renderScrapeTranscript(fx.url, scratchDir);
      return createLlm("replay", { fixturePath, trace });
    },
  });

  const assetExecutor = createAssetExecutor({
    gate,
    blobs,
    db: handle.db,
    render,
    llmFor: ({ trace }) =>
      spliceRealAssetRef(createLlm("replay", { fixturePath: path.join(transcriptsDir, REPORT_TRANSCRIPT), trace })),
  });

  const dispatcher = createDispatcher(handle, { intervalMs: 25, backoffBaseMs: 10 });
  const engine = createEngine({
    db: handle.db,
    dispatcher,
    executors: {
      [executorKey("browser", "ai")]: browserExecutor,
      [executorKey("asset", "ai")]: assetExecutor,
    },
    watchdogIntervalMs: 50,
    // A real sandboxed tectonic compile plus a real page load and form submit are both
    // slower than a stub — long enough that teardown never races a run still mid-render.
    shutdownGraceMs: 15_000,
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
    userId,
    stop: async () => {
      await dispatcher.stop();
      await engine.stop();
      await pool.close();
      await Promise.all([chrome.close(), fx.close(), handle.close(), testBlobs.drop()]);
    },
  };
}

export async function traceRowsFor(rig: TwoKindRig, runId: string): Promise<TraceEntryRow[]> {
  return rig.handle.db.select().from(traceEntries).where(eq(traceEntries.runId, runId)).orderBy(asc(traceEntries.seq));
}

export type FakeGramSubmission = { kind: string; fields: Record<string, string>; at: string };

/** `GET /fake-gram/admin/submissions` — the byte-match and dedupe assertions both read this. */
export async function fakeGramSubmissions(rig: TwoKindRig): Promise<FakeGramSubmission[]> {
  const res = await fetch(`${rig.fx.url}/fake-gram/admin/submissions`);
  const body = (await res.json()) as { submissions: FakeGramSubmission[] };
  return body.submissions;
}

// --- PDF sanity (deliverable 4: "the PDF is a valid PDF; parses, non-zero page count") -----
//
// No PDF-parsing dependency exists in this workspace (house rule: no new deps) — tectonic's
// output uses compressed object streams (`/Type/ObjStm`), so `/Type /Page` never appears as
// plain text in a rendered PDF; it is verified empirically (against a real render from this
// subphase's own renderer rig) that inflating every `stream`...`endstream` region with zlib
// and searching the concatenated result finds it. This is a page *count heuristic*, not a
// structural parse (no xref/object-graph walk) — proportionate to what this test needs to
// prove ("the bytes are a real, non-empty PDF"), not a general PDF reader.

function extractFlateStreams(pdf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const streamMarker = Buffer.from("stream");
  const endstreamMarker = Buffer.from("endstream");
  let idx = 0;
  for (;;) {
    const s = pdf.indexOf(streamMarker, idx);
    if (s === -1) break;
    let dataStart = s + streamMarker.length;
    if (pdf[dataStart] === 0x0d && pdf[dataStart + 1] === 0x0a) dataStart += 2;
    else if (pdf[dataStart] === 0x0a) dataStart += 1;
    const e = pdf.indexOf(endstreamMarker, dataStart);
    if (e === -1) break;
    let dataEnd = e;
    while (dataEnd > dataStart && (pdf[dataEnd - 1] === 0x0a || pdf[dataEnd - 1] === 0x0d)) dataEnd--;
    try {
      out.push(inflateSync(pdf.subarray(dataStart, dataEnd)));
    } catch {
      // Not flate/zlib-encoded (or not independently inflatable, e.g. predictor-filtered) —
      // skip; the page objects this heuristic looks for are never the ones that fail here.
    }
    idx = e + endstreamMarker.length;
  }
  return out;
}

/** `%PDF-` header present, and at least one `/Type /Page` (never `/Type /Pages`, the tree
 * node) found either in plain PDF body text or inside a decompressed object stream. */
export function isValidPdfWithPages(pdf: Buffer): boolean {
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") return false;
  return countPdfPages(pdf) > 0;
}

export function countPdfPages(pdf: Buffer): number {
  const pageType = /\/Type\s*\/Page(?!s)\b/g;
  let count = (pdf.toString("latin1").match(pageType) || []).length;
  for (const decoded of extractFlateStreams(pdf)) {
    count += (decoded.toString("latin1").match(pageType) || []).length;
  }
  return count;
}
