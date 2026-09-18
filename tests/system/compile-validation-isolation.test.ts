import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { replayLlm } from "@tabductor/agent";
import { compileTask, type RunTrace } from "@tabductor/compiler";
import { compiledScripts } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { seedWorkflow } from "@tabductor/engine";
import { startFixtures, type Fixtures } from "@tabductor/testkit";
import { eq } from "drizzle-orm";

/**
 * Validation must not repeat the run's side effects.
 *
 * This is the gap S6e closes, stated as the case that made it a gap: a task whose work is to
 * **publish a post**. The old pipeline dry-ran the candidate on the workflow's own endpoint
 * against the real site, and suppressed only the event bus — so validating this script would
 * have submitted the form. Suppressing emissions does not make a live replay safe; the post
 * is the side effect, and it is not an emission.
 *
 * The candidate here clicks the submit button. The assertion is that FakeGram — a real HTTP
 * server, running, reachable, counting every submission it receives — saw nothing at all.
 */

const TRANSCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "transcripts");

let handle: MigratedTestDb | undefined;
let fx: Fixtures | undefined;

afterEach(async () => {
  await handle?.close();
  await fx?.close();
  handle = undefined;
  fx = undefined;
});

async function submissionCount(fixtures: Fixtures): Promise<number> {
  const res = await fetch(`${fixtures.url}/fake-gram/admin/submissions`);
  const body = (await res.json()) as { submissions: unknown[] };
  return body.submissions.length;
}

/** The compiler's transcript, with the fixture origin substituted the way the rig does it. */
function transcript(name: string, fxUrl: string): string {
  const raw = readFileSync(path.join(TRANSCRIPTS, name), "utf8").replaceAll("__FX_URL__", fxUrl);
  const out = path.join(mkdtempSync(path.join(tmpdir(), "tabductor-compile-iso-")), name);
  writeFileSync(out, raw);
  return out;
}

it("validating a script that posts a form does not post the form", async () => {
  fx = await startFixtures();
  handle = await createMigratedTestDb();
  const db = handle.db;
  const wf = await seedWorkflow(db, {
    tasks: { Post: { kind: "browser", mode: "ai", prompt: "Publish the queued caption.", emits: ["post.published"] } },
  });
  const taskId = wf.taskIds.Post!;
  const url = `${fx.url}/fake-gram`;

  // The agent's own run *did* post — that is the work, and it is why this task is compilable
  // at all. The count below starts at whatever that run left behind: nothing here replays it.
  const trace: RunTrace = {
    runId: "run_post",
    entries: [
      { seq: -1, kind: "runtime", payload: { browserVersion: "test-browser-v1", runtimeVersion: "tabductor-static-v1" } },
      { seq: 0, kind: "navigation", payload: { url, cause: "initial" } },
      { seq: 1, kind: "action", payload: { action: "goto", url, ok: true } },
      { seq: 2, kind: "action", payload: { action: "perceive", elementCount: 12, ok: true } },
      { seq: 3, kind: "action", payload: { action: "type", selector: "#create-post input[name='caption']", length: 9, ok: true } },
      { seq: 4, kind: "action", payload: { action: "click", selector: "#create-post button[type='submit']", ok: true } },
      { seq: 5, kind: "action", payload: { action: "queryAll", selector: "#create-post", fields: ["caption"], count: 1, ok: true } },
      { seq: 6, kind: "action", payload: { action: "emit", type: "post.published", dedupeKey: "a caption", ok: true } },
    ],
  };

  const before = await submissionCount(fx);
  const result = await compileTask(
    { db, llm: replayLlm(transcript("compiler-fake-gram-post.jsonl", fx.url)) },
    { taskId, sourceRunId: "run_post", traces: [trace] },
  );

  expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(true);
  if (!result.ok) return;
  // The candidate really does click submit — this is not a script that quietly avoided the
  // dangerous step and passed for that reason.
  expect(result.script.source).toContain("ctx.page.click(\"#create-post button[type='submit']\")");
  expect(await db.select().from(compiledScripts).where(eq(compiledScripts.taskId, taskId))).toHaveLength(1);

  // And FakeGram never heard from it. Three validation passes, one form submission in each if
  // any of this were live; zero.
  expect(await submissionCount(fx)).toBe(before);
}, 120_000);
