import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { replayLlm } from "@tabductor/agent";
import { compileTask, lintScript, type RunTrace, type WorkPlan } from "@tabductor/compiler";
import { compiledScripts } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { seedWorkflow } from "@tabductor/engine";
import { eq } from "drizzle-orm";

/**
 * The compile pipeline: one finished execution in, a validated candidate out — or a refusal
 * and no row.
 *
 * The traces below are deliberately *messy*. A real agent run perceives the page, guesses a
 * selector, tries a menu that turns out to be irrelevant and fails an action before it finds
 * the thing it came for, and the old checker's answer to that was to filter the mess away and
 * demand two runs produce the identical remainder. The contract
 * (`docs/trace-compilation.md`) asks for the opposite: hand the model everything, let it say
 * which of it was work, and check *that claim* against the evidence.
 *
 * So every case here asserts one of the two halves of that division:
 * - the model's interpretation is grounded in the evidence (or the plan gate refuses it), and
 * - the code it then writes actually does the work, idempotently, and deopts when the page
 *   moves (or the validation gate refuses it).
 *
 * **No browser anywhere in this file.** Validation runs the candidate against a page built out
 * of the trace, three times (`packages/compiler/src/validate.ts`), which is what makes it safe
 * to validate a script whose live equivalent would post, submit or send something.
 */

const TRANSCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "transcripts");
const llm = (name: string) => replayLlm(path.join(TRANSCRIPTS, name));
const refusingLlm = {
  complete: async () => {
    throw new Error("the model must not be called");
  },
};

const URL = "https://timeline.test/home";

let handle: MigratedTestDb | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

type Entry = { seq: number; kind: string; payload: Record<string, unknown> };

function trace(runId: string, entries: (seq: () => number) => Entry[]): RunTrace {
  let n = 0;
  return { runId, entries: entries(() => n++) };
}

/** What a first exploratory run actually leaves behind: looking, guessing, one dead end, then
 * the work. */
function exploratoryTrace(runId: string): RunTrace {
  return trace(runId, (s) => [
    { seq: s(), kind: "navigation", payload: { url: URL, cause: "initial" } },
    { seq: s(), kind: "action", payload: { action: "goto", url: URL, ok: true } },
    { seq: s(), kind: "llm", payload: { prompt_hash: "h1", usage: { in: 900, out: 120 } } },
    { seq: s(), kind: "action", payload: { action: "perceive", elementCount: 42, textChars: 3100, ok: true } },
    { seq: s(), kind: "action", payload: { action: "click", selector: "nav.explore", ok: true } },
    { seq: s(), kind: "action", payload: { action: "perceive", elementCount: 61, textChars: 4200, ok: true } },
    { seq: s(), kind: "action", payload: { action: "queryAll", selector: "article.post", fields: ["text"], ok: false, error: "no element matched" } },
    { seq: s(), kind: "action", payload: { action: "waitFor", selector: "article", timeout: 8000, ok: true } },
    { seq: s(), kind: "action", payload: { action: "queryAll", selector: "article", fields: ["text", "url"], count: 3, ok: true } },
    { seq: s(), kind: "action", payload: { action: "emit", type: "post.detected", dedupeKey: "/status/1", ok: true } },
    { seq: s(), kind: "action", payload: { action: "emit", type: "post.detected", dedupeKey: "/status/2", ok: true } },
    { seq: s(), kind: "action", payload: { action: "emit", type: "post.detected", dedupeKey: "/status/3", ok: true } },
  ]);
}

/** The same work, found a completely different way: no menu, a scroll, twice as much looking,
 * and the extraction discovered from the other end. Nothing about the *work* differs. */
function otherPathTrace(runId: string): RunTrace {
  return trace(runId, (s) => [
    { seq: s(), kind: "navigation", payload: { url: `${URL}?src=notif`, cause: "initial" } },
    { seq: s(), kind: "action", payload: { action: "goto", url: `${URL}?src=notif`, ok: true } },
    { seq: s(), kind: "action", payload: { action: "perceive", elementCount: 51, textChars: 2900, ok: true } },
    { seq: s(), kind: "action", payload: { action: "scroll", direction: "down", ok: true } },
    { seq: s(), kind: "action", payload: { action: "perceive", elementCount: 77, textChars: 5100, ok: true } },
    { seq: s(), kind: "action", payload: { action: "queryAll", selector: "article", fields: ["text", "url"], count: 5, ok: true } },
    { seq: s(), kind: "action", payload: { action: "emit", type: "post.detected", dedupeKey: "/status/4", ok: true } },
  ]);
}

async function taskOf(
  kind: "browser" | "decision",
  emits: string[] = ["post.detected"],
): Promise<{ db: MigratedTestDb["db"]; taskId: string }> {
  handle = await createMigratedTestDb();
  const wf = await seedWorkflow(handle.db, {
    tasks: { T: { kind, mode: "ai", prompt: "Watch the timeline and report new posts.", emits } },
  });
  return { db: handle.db, taskId: wf.taskIds.T! };
}

const rowsFor = (db: MigratedTestDb["db"], taskId: string) =>
  db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId));

it("distils one exploratory run into a script that reproduces the work and not the looking around", async () => {
  const { db, taskId } = await taskOf("browser");
  const source = exploratoryTrace("run_a");

  const result = await compileTask(
    { db, llm: llm("compiler-posts.jsonl") },
    { taskId, sourceRunId: "run_a", traces: [source] },
  );

  expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(true);
  if (!result.ok) return;

  expect(result.script.status).toBe("candidate");
  expect(result.script.version).toBe(1);
  // K=1: one finished execution is the whole provenance.
  expect(result.script.fromRuns).toEqual(["run_a"]);

  // The plan is kept beside the script: what the compiler decided was work, and what it threw
  // away, is the audit trail for both a promotion and a later "why does it not do X?".
  const plan = (result.script.guardsMeta as { plan: WorkPlan }).plan;
  expect(plan.steps.some((s) => s.op === "emit" && s.eventType === "post.detected")).toBe(true);
  expect(plan.discarded.length).toBeGreaterThan(0);

  // The §11 shape, and — the point of the whole subphase — no trace of the exploration.
  expect(result.script.source).toContain("ctx.guard.all");
  expect(result.script.source).toContain("ctx.deopt");
  expect(result.script.source).toContain("ctx.page.evalExtract");
  expect(result.script.source).toContain("ctx.emitIfNew");
  expect(result.script.source).not.toContain("nav.explore");
  expect(result.script.source).not.toContain("perceive");
  expect(result.script.source).not.toContain("article.post");
  expect(lintScript(result.script.source)).toEqual({ ok: true });
}, 120_000);

/**
 * Two runs that found the page differently. The old checker compared step sequences and would
 * have called these divergent — different lengths, different actions, a scroll in one and a
 * menu click in the other. They did the same job, and the plan is what says so.
 */
it("two runs that discovered the page differently compile to the one task they both performed", async () => {
  const { db, taskId } = await taskOf("browser");

  const result = await compileTask(
    { db, llm: llm("compiler-posts-two-runs.jsonl") },
    { taskId, sourceRunId: "run_a", traces: [exploratoryTrace("run_a"), otherPathTrace("run_b")] },
  );

  expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(true);
  if (!result.ok) return;
  expect(result.script.fromRuns).toEqual(["run_a", "run_b"]);
}, 120_000);

it("strips a markdown fence off both the plan and the script rather than failing on it", async () => {
  const { db, taskId } = await taskOf("browser");
  const result = await compileTask(
    { db, llm: llm("compiler-fenced.jsonl") },
    { taskId, sourceRunId: "run_a", traces: [exploratoryTrace("run_a")] },
  );
  expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(true);
  if (!result.ok) return;
  expect(result.script.source.startsWith("export default")).toBe(true);
}, 120_000);

/**
 * The grounding gate. A selector the run never addressed is a guess about a page nobody has
 * seen, and it is refused before a line of code is written — the transcript for this case has
 * a plan turn and nothing else, so a pipeline that went on to ask for a script would fail loudly.
 */
it("a plan that invents a selector is refused before any code is written", async () => {
  const { db, taskId } = await taskOf("browser");
  const result = await compileTask(
    { db, llm: llm("compiler-invented-selector.jsonl") },
    { taskId, sourceRunId: "run_a", traces: [exploratoryTrace("run_a")] },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("plan");
  expect(result.error).toContain("div.feed-item");
  expect(await rowsFor(db, taskId)).toHaveLength(0);
}, 120_000);

/** Exploration may be discarded; work may not. */
it("a plan that drops an event the run published is refused", async () => {
  const { db, taskId } = await taskOf("browser");
  const result = await compileTask(
    { db, llm: llm("compiler-drops-emit.jsonl") },
    { taskId, sourceRunId: "run_a", traces: [exploratoryTrace("run_a")] },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("plan");
  expect(result.error).toContain("post.detected");
  expect(await rowsFor(db, taskId)).toHaveLength(0);
}, 120_000);

/**
 * Validation runs the candidate twice against the same state. A script that emits without a
 * dedupe key passes lint, does the work, and publishes everything a second time — which is a
 * duplicate storm on the first re-run, in production, in a week.
 */
it("a script that emits without a dedupe key never becomes a candidate", async () => {
  const { db, taskId } = await taskOf("browser");
  const result = await compileTask(
    { db, llm: llm("compiler-no-dedupe.jsonl"), maxAttempts: 1 },
    { taskId, sourceRunId: "run_a", traces: [exploratoryTrace("run_a")] },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("validation");
  expect(result.error).toContain("dedupe key");
  expect(await rowsFor(db, taskId)).toHaveLength(0);
}, 120_000);

/**
 * The third validation pass: the page moved. A script with no guard block still completes
 * against a page that no longer has what it needs — and a script that cannot deopt is one
 * that fails a run outright the day the layout changes, instead of handing it to the agent.
 */
it("a script whose guards cannot fail never becomes a candidate", async () => {
  const { db, taskId } = await taskOf("browser");
  const result = await compileTask(
    { db, llm: llm("compiler-blind-guards.jsonl"), maxAttempts: 1 },
    { taskId, sourceRunId: "run_a", traces: [exploratoryTrace("run_a")] },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("validation");
  expect(result.error).toMatch(/guards check nothing|instead of deopting/);
  expect(await rowsFor(db, taskId)).toHaveLength(0);
}, 120_000);

/** The gate's own words go back to the model verbatim — the S5e TeX-log shape. */
it("feeds a lint failure back and accepts the corrected second attempt", async () => {
  const { db, taskId } = await taskOf("browser");
  const result = await compileTask(
    { db, llm: llm("compiler-self-repair.jsonl") },
    { taskId, sourceRunId: "run_a", traces: [exploratoryTrace("run_a")] },
  );
  expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(true);
  if (!result.ok) return;
  expect(result.script.source).not.toContain("eval(");
  // Exactly one row: the rejected attempt was never stored.
  expect(await rowsFor(db, taskId)).toHaveLength(1);
}, 120_000);

it("writes no row when the retry budget is exhausted, and says which rule rejected it", async () => {
  const { db, taskId } = await taskOf("browser");
  const result = await compileTask(
    { db, llm: llm("compiler-lint-exhausted.jsonl") },
    { taskId, sourceRunId: "run_a", traces: [exploratoryTrace("run_a")] },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("lint");
  expect(result.error).toContain("no-eval");
  expect(await rowsFor(db, taskId)).toHaveLength(0);
}, 120_000);

/**
 * "The compiler must not invent the missing work." A task whose storage flags turned action
 * recording off leaves a trace that says a run happened and nothing about what it did.
 */
it("a trace with no action evidence is refused without calling the model", async () => {
  const { db, taskId } = await taskOf("browser");
  const blind = trace("run_a", (s) => [
    { seq: s(), kind: "llm", payload: { prompt_hash: "h1", usage: { in: 10, out: 10 } } },
  ]);
  const result = await compileTask({ db, llm: refusingLlm }, { taskId, sourceRunId: "run_a", traces: [blind] });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("evidence");
  expect(result.error).toContain("no actions");
  expect(await rowsFor(db, taskId)).toHaveLength(0);
}, 120_000);

/**
 * The §4 boundary. Decision work remains semantic until a guarded store runtime exists.
 */
it("a decision task is not compiled, even with clean evidence", async () => {
  const kind = "decision" as const;
  const { db, taskId } = await taskOf(kind);
  const result = await compileTask(
    { db, llm: refusingLlm },
    { taskId, sourceRunId: "run_a", traces: [exploratoryTrace("run_a")] },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe("kind");
  expect(await rowsFor(db, taskId)).toHaveLength(0);
}, 120_000);
