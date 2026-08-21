import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { replayLlm } from "@tabductor/agent";
import { compileTask, lintScript, type RunTrace } from "@tabductor/compiler";
import { compiledScripts } from "@tabductor/db";
import { seedWorkflow } from "@tabductor/engine";
import type { CtxHost } from "@tabductor/static-rt";
import { eq } from "drizzle-orm";
import { openSession, startBrowserRig, type BrowserRig, type SessionRig } from "./browser-support.js";
import { memoryState, recordingEmit } from "./static-rt-support.js";

/**
 * The compile pipeline: consistent traces in, a `candidate` row out — or a refusal and no row.
 *
 * Every rejection case asserts **both** halves: the descriptive error and the absence of a row.
 * A pipeline that returned an error but wrote a row anyway would pass the first assertion, and
 * that row would then be a candidate for activation.
 *
 * The dry run uses a real browser session on `fake-tweets`, because the whole point of it is
 * that a script which passes a parser can still throw when it meets a page. A stub session
 * would make the stage a formality.
 */

const TRANSCRIPTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "transcripts",
);

let rig: BrowserRig;
let sess: SessionRig | undefined;

beforeAll(async () => {
  rig = await startBrowserRig();
}, 120_000);

afterAll(async () => {
  await rig?.close();
});

afterEach(async () => {
  await sess?.close();
  sess = undefined;
});

let seq = 0;
const act = (payload: Record<string, unknown>) => ({ seq: seq++, kind: "action", payload: { ok: true, ...payload } });

function traces(url: string): RunTrace[] {
  const one = (runId: string): RunTrace => {
    seq = 0;
    return {
      runId,
      entries: [
        { seq: seq++, kind: "navigation", payload: { url, cause: "initial" } },
        act({ action: "goto", url }),
        act({ action: "waitFor", selector: "article", timeout: 8000 }),
        act({ action: "queryAll", selector: "article", fields: ["text", "url"] }),
        act({ action: "emit", type: "tweet.detected", dedupeKey: "/status/1" }),
      ],
    };
  };
  return [one("run_a"), one("run_b")];
}

/** A fresh dry-run host on a page the script was compiled for. */
async function dryRunHost(): Promise<CtxHost> {
  sess = await openSession(rig);
  await sess.session.page.goto(`${rig.fx.url}/fake-tweets`);
  return { session: sess.session, emit: recordingEmit(), state: memoryState() };
}

async function taskOf(kind: "browser" | "asset" | "decision"): Promise<string> {
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { T: { kind, mode: kind === "browser" ? "ai" : "ai", prompt: "Watch the timeline and report new tweets." } },
  });
  return wf.taskIds.T!;
}

const rowsFor = (taskId: string) =>
  rig.handle.db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId));

it("compiles consistent traces into a candidate that passes lint and a real dry run", async () => {
  const taskId = await taskOf("browser");
  const result = await compileTask(
    { db: rig.handle.db, llm: replayLlm(path.join(TRANSCRIPTS, "compiler-tweets.jsonl")), dryRunHost },
    taskId,
    traces(`${rig.fx.url}/fake-tweets`),
  );

  expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(true);
  if (!result.ok) return;

  expect(result.script.status).toBe("candidate");
  expect(result.script.version).toBe(1);
  expect(result.script.fromRuns).toEqual(["run_a", "run_b"]);
  // Provenance the compiler recorded, so a later reader can see what the guards were for.
  expect((result.script.guardsMeta as { emits: string[] }).emits).toEqual(["tweet.detected"]);

  // The stored source is the §11 shape: guard block first, deopt on failure, declarative
  // extraction, idempotent emit.
  expect(result.script.source).toContain("ctx.guard.all");
  expect(result.script.source).toContain("ctx.deopt");
  expect(result.script.source).toContain("ctx.page.evalExtract");
  expect(result.script.source).toContain("ctx.emitIfNew");
  expect(lintScript(result.script.source)).toEqual({ ok: true });
}, 180_000);

it("strips a markdown fence rather than failing on it", async () => {
  const taskId = await taskOf("browser");
  const result = await compileTask(
    { db: rig.handle.db, llm: replayLlm(path.join(TRANSCRIPTS, "compiler-fenced.jsonl")), dryRunHost },
    taskId,
    traces(`${rig.fx.url}/fake-tweets`),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.script.source.startsWith("export default")).toBe(true);
}, 180_000);

/** The gate's own words go back to the model verbatim — the S5e TeX-log shape. */
it("feeds a lint failure back and accepts the corrected second attempt", async () => {
  const taskId = await taskOf("browser");
  const result = await compileTask(
    { db: rig.handle.db, llm: replayLlm(path.join(TRANSCRIPTS, "compiler-self-repair.jsonl")), dryRunHost },
    taskId,
    traces(`${rig.fx.url}/fake-tweets`),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.script.source).not.toContain("eval(");
  // Exactly one row: the rejected attempt was never stored.
  expect(await rowsFor(taskId)).toHaveLength(1);
}, 180_000);

it("writes no row when the retry budget is exhausted, and says which rule rejected it", async () => {
  const taskId = await taskOf("browser");
  const result = await compileTask(
    { db: rig.handle.db, llm: replayLlm(path.join(TRANSCRIPTS, "compiler-lint-exhausted.jsonl")), dryRunHost },
    taskId,
    traces(`${rig.fx.url}/fake-tweets`),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("lint");
  expect(result.error).toContain("no-eval");
  expect(await rowsFor(taskId)).toHaveLength(0);
}, 180_000);

/**
 * The stage that only a real run can catch: this script contains nothing the parser objects
 * to, and throws the moment it touches a page.
 */
it("a script that passes lint but throws in the dry run is not stored", async () => {
  const taskId = await taskOf("browser");
  const result = await compileTask(
    { db: rig.handle.db, llm: replayLlm(path.join(TRANSCRIPTS, "compiler-dry-run-throws.jsonl")), dryRunHost },
    taskId,
    traces(`${rig.fx.url}/fake-tweets`),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("dry_run");
  expect(result.error).toContain("dry run threw");
  expect(await rowsFor(taskId)).toHaveLength(0);
}, 180_000);

it("inconsistent traces are refused before the model is ever called", async () => {
  const taskId = await taskOf("browser");
  const [a, b] = traces(`${rig.fx.url}/fake-tweets`);
  b!.entries = b!.entries.map((e) =>
    e.payload.action === "queryAll" ? { ...e, payload: { ...e.payload, selector: "article.tweet" } } : e,
  );

  const result = await compileTask(
    // An LLM that would throw if reached: the consistency gate must come first.
    { db: rig.handle.db, llm: { complete: async () => { throw new Error("the model must not be called"); } }, dryRunHost },
    taskId,
    [a!, b!],
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("consistency");
  expect(result.error).toContain("locator diverged");
  expect(await rowsFor(taskId)).toHaveLength(0);
}, 180_000);

/**
 * The §4 boundary. `asset` is a permanent exclusion — MCP results and LLM prose have no stable
 * structure for a guard to assert on. `decision` is "not yet": it joins the list when
 * `ctx.store` lands in the static runtime, which is why the filter is an allowlist and not
 * `!== 'asset'`.
 */
it.each(["asset", "decision"] as const)("a %s task is not compiled, even with clean traces", async (kind) => {
  const taskId = await taskOf(kind);
  const result = await compileTask(
    { db: rig.handle.db, llm: { complete: async () => { throw new Error("the model must not be called"); } }, dryRunHost },
    taskId,
    traces(`${rig.fx.url}/fake-tweets`),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("kind");
  expect(await rowsFor(taskId)).toHaveLength(0);
}, 180_000);
