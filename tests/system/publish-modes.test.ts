import { afterEach, expect, it } from "vitest";
import { activateScript, insertCandidateScript } from "@tabductor/compiler";
import { compiledScripts, tasks } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  createWorkflow,
  llmPromptCompiler,
  publishVersion,
  readGraph,
  staticSchemaGenerator,
  type ChatTransport,
  type Graph,
  type PromptCompiler,
} from "@tabductor/engine";
import { wfIdsOf } from "@tabductor/store";
import { eq, sql } from "drizzle-orm";

/**
 * What a publish compiles besides packet schemas — the internal per-node prompt — and what it
 * carries forward: the prompt by hash, and a browser task's compiled script (with mode
 * `compiled`) by content hash. The author edits a sentence; the engine runs on a brief.
 */

const SCHEMAS = {
  "tweet.detected": {
    type: "object",
    properties: { text: { type: "string" }, url: { type: "string" } },
    required: ["text", "url"],
    additionalProperties: false,
  },
};
const generator = staticSchemaGenerator(SCHEMAS);

function graph(overrides: { scrapePrompt?: string; reportPrompt?: string } = {}): Graph {
  return {
    tasks: [
      {
        name: "Scrape",
        kind: "browser",
        mode: "ai",
        prompt: overrides.scrapePrompt ?? "Watch the timeline and report new tweets.",
        limits: {},
        emits: ["tweet.detected"],
        consumes: [],
        schedule: { cron: "0 7 * * *", tz: "UTC", missedPolicy: "skip", overlapPolicy: "skip", maxQueueDepth: 1, enabled: true },
        position: null,
      },
      {
        name: "Report",
        kind: "asset",
        mode: "ai",
        prompt: overrides.reportPrompt ?? "Append each tweet to the daily report.",
        limits: {},
        emits: [],
        consumes: ["tweet.detected"],
        schedule: null,
        position: null,
      },
    ],
    events: [{ type: "tweet.detected", description: "One new tweet: its text and permalink.", public: false }],
  };
}

let handle: MigratedTestDb | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function fresh(): Promise<{ handle: MigratedTestDb; workflowId: string }> {
  handle = await createMigratedTestDb();
  const workflowId = await createWorkflow(handle.db, { name: "modes", userId: "user_test" });
  return { handle, workflowId };
}

const rowsOf = (h: MigratedTestDb, versionId: string) =>
  h.db.select().from(tasks).where(eq(tasks.workflowVersionId, versionId)).orderBy(tasks.name);

it("publish compiles an internal prompt per node from the whole graph, and the author's prompt stays bare", async () => {
  const { handle: h, workflowId } = await fresh();
  const { versionId, report, taskModes } = await publishVersion(h.db, { workflowId, graph: graph() }, { schemaGenerator: generator });

  const [report$, scrape] = await rowsOf(h, versionId);
  expect(scrape!.prompt).toBe("Watch the timeline and report new tweets.");
  expect(taskModes).toEqual({ Scrape: "ai", Report: "ai" });
  expect(report.tasks.map((t) => [t.name, t.status])).toEqual([
    ["Scrape", "generated"],
    ["Report", "generated"],
  ]);

  const brief = scrape!.compiledPrompt!;
  // The author's sentence, the event it must emit with its exact schema, who consumes it,
  // the kind's real tool surface, and a schedule note — none of which the sentence carried.
  expect(brief).toContain('# Node "Scrape" (kind: browser)');
  expect(brief).toContain("Watch the timeline and report new tweets.");
  expect(brief).toContain("- tweet.detected — One new tweet: its text and permalink.");
  expect(brief).toContain("consumed by: Report");
  expect(brief).toContain(JSON.stringify(SCHEMAS["tweet.detected"]));
  expect(brief).toContain("- page.goto:");
  expect(brief).toContain('cron "0 7 * * *"');
  expect(brief).not.toContain("python.run");
  expect(brief).not.toContain("Workflow store tables");

  const assetBrief = report$!.compiledPrompt!;
  expect(assetBrief).toContain("## Events that trigger this node");
  expect(assetBrief).toContain("emitted by: Scrape");
  expect(assetBrief).toContain("- python.run:");
  expect(assetBrief).toContain("- store.query:");
  expect(assetBrief).toContain("(none declared — do not call emit)");
  expect(scrape!.contentHash).toMatch(/^[0-9a-f]{64}$/);
});

it("an unchanged node's prompt is carried forward by hash; a neighbour's edit recompiles it", async () => {
  const { handle: h, workflowId } = await fresh();
  const v1 = await publishVersion(h.db, { workflowId, graph: graph() }, { schemaGenerator: generator });
  const v2 = await publishVersion(h.db, { workflowId, graph: graph() }, { schemaGenerator: generator });
  expect(v2.report.tasks.map((t) => t.status)).toEqual(["reused", "reused"]);
  const [r1, s1] = await rowsOf(h, v1.versionId);
  const [r2, s2] = await rowsOf(h, v2.versionId);
  expect(s2!.compiledPrompt).toBe(s1!.compiledPrompt);
  expect(r2!.compiledPrompt).toBe(r1!.compiledPrompt);

  // Report's prompt is part of Scrape's brief (the neighbour list), so both recompile.
  const v3 = await publishVersion(h.db, { workflowId, graph: graph({ reportPrompt: "Write a PDF instead." }) }, { schemaGenerator: generator });
  expect(v3.report.tasks.map((t) => t.status)).toEqual(["generated", "generated"]);
  const [, s3] = await rowsOf(h, v3.versionId);
  expect(s3!.compiledPrompt).toContain("Write a PDF instead.");
  expect(s3!.contentHash).not.toBe(s1!.contentHash);
});

/** A scripted transport: each call pops the next reply, so a test can stage a repair turn. */
function scripted(replies: Array<string | Error | { refused: true }>): ChatTransport & { turnsSeen: number[] } {
  const t = {
    turnsSeen: [] as number[],
    async complete(turns: Array<{ role: string; content: string }>) {
      t.turnsSeen.push(turns.length);
      const next = replies.shift();
      if (next === undefined) throw new Error("no reply staged");
      if (next instanceof Error) throw next;
      if (typeof next === "object") return next;
      return { text: next };
    },
  };
  return t;
}

it("the model layer is gated on naming every emitted event, gets one repair turn, and sits atop the brief", async () => {
  const transport = scripted(["Open the page and extract tweets.", "Open the page, extract tweets, and emit tweet.detected once per tweet."]);
  const compiler = llmPromptCompiler(transport);
  const { handle: h, workflowId } = await fresh();
  const { versionId, report } = await publishVersion(h.db, { workflowId, graph: graph() }, { schemaGenerator: generator, promptCompiler: compiler });

  const [, scrape] = await rowsOf(h, versionId);
  expect(scrape!.compiledPrompt!.startsWith("Open the page, extract tweets, and emit tweet.detected once per tweet.")).toBe(true);
  expect(scrape!.compiledPrompt).toContain('# Node "Scrape" (kind: browser)');
  // First attempt (1 turn), then the repair conversation (3 turns) — for Scrape; Report has
  // nothing to emit so its first reply passes.
  expect(transport.turnsSeen).toEqual([1, 3, 1]);
  expect(report.tasks.find((t) => t.name === "Scrape")?.status).toBe("generated");
});

it("a model that fails or refuses leaves the brief as the compiled prompt, reported as `brief`, and the publish succeeds", async () => {
  const failing: PromptCompiler = { compile: async () => ({ ok: false, error: "provider is down" }) };
  const { handle: h, workflowId } = await fresh();
  const { versionId, report } = await publishVersion(h.db, { workflowId, graph: graph() }, { schemaGenerator: generator, promptCompiler: failing });

  expect(report.tasks.map((t) => [t.status, t.error])).toEqual([
    ["brief", "provider is down"],
    ["brief", "provider is down"],
  ]);
  const [, scrape] = await rowsOf(h, versionId);
  expect(scrape!.compiledPrompt).toContain('# Node "Scrape" (kind: browser)');

  const refused = llmPromptCompiler(scripted([{ refused: true }, { refused: true }]));
  const again = await publishVersion(h.db, { workflowId, graph: graph({ scrapePrompt: "Different." }) }, { schemaGenerator: generator, promptCompiler: refused });
  expect(again.report.tasks.every((t) => t.status === "brief")).toBe(true);
});

it("a promoted browser task keeps its script and `compiled` across an unchanged publish, and loses both when its content changes", async () => {
  const { handle: h, workflowId } = await fresh();
  const v1 = await publishVersion(h.db, { workflowId, graph: graph() }, { schemaGenerator: generator });
  const scrape1 = v1.taskIds.Scrape!;

  // What promotion does: an active script on the shelf and the row flipped to `compiled`.
  const script = await insertCandidateScript(h.db, { taskId: scrape1, source: "// v1 script", fromRuns: ["run_1"], guardsMeta: { emits: ["tweet.detected"] } });
  await activateScript(h.db, script.id);
  await h.db.update(tasks).set({ mode: "compiled" }).where(eq(tasks.id, scrape1));

  // The editor round trip: a promoted row reads back as the `ai` the author published.
  const doc = await readGraph(h.db, v1.versionId);
  expect(doc.tasks.find((t) => t.name === "Scrape")?.mode).toBe("ai");

  // Republishing the same document — a timeout tweak, say — keeps the fast path.
  const v2 = await publishVersion(h.db, { workflowId, graph: doc }, { schemaGenerator: generator });
  expect(v2.taskModes.Scrape).toBe("compiled");
  expect(v2.report.tasks.find((t) => t.name === "Scrape")?.mode).toBe("compiled");
  const [, scrape2] = await rowsOf(h, v2.versionId);
  expect(scrape2!.mode).toBe("compiled");
  const carried = await h.db.select().from(compiledScripts).where(eq(compiledScripts.taskId, scrape2!.id));
  expect(carried).toHaveLength(1);
  expect(carried[0]).toMatchObject({ status: "active", source: "// v1 script", fromRuns: ["run_1"], version: 1 });

  // A prompt edit changes the content hash: back to `ai`, nothing on the shelf.
  const v3 = await publishVersion(h.db, { workflowId, graph: graph({ scrapePrompt: "Watch replies instead." }) }, { schemaGenerator: generator });
  expect(v3.taskModes.Scrape).toBe("ai");
  const [, scrape3] = await rowsOf(h, v3.versionId);
  expect(scrape3!.mode).toBe("ai");
  expect(await h.db.select().from(compiledScripts).where(eq(compiledScripts.taskId, scrape3!.id))).toHaveLength(0);

  // Authoring `stub` on a promoted task is the author's call and wins over carry-forward.
  const v4 = await publishVersion(
    h.db,
    { workflowId, graph: { ...graph(), tasks: graph().tasks.map((t) => (t.name === "Scrape" ? { ...t, mode: "stub" } : t)) } },
    { schemaGenerator: generator },
  );
  expect(v4.taskModes.Scrape).toBe("stub");
});

it("a publish given a pool prepares the workflow's store schema and role pair", async () => {
  const { handle: h, workflowId } = await fresh();
  const ids = wfIdsOf(workflowId);
  const schemaExists = async () =>
    (await h.db.execute(sql`select 1 from pg_namespace where nspname = ${ids.schema}`)).rows.length === 1;
  expect(await schemaExists()).toBe(false);

  await publishVersion(h.db, { workflowId, graph: graph() }, { schemaGenerator: generator, pool: h.pool });
  expect(await schemaExists()).toBe(true);
  const roles = await h.db.execute(sql`select rolname from pg_roles where rolname in (${ids.readerRole}, ${ids.writerRole})`);
  expect(roles.rows).toHaveLength(2);

  // Idempotent: the second publish finds the schema already there.
  await publishVersion(h.db, { workflowId, graph: graph() }, { schemaGenerator: generator, pool: h.pool });
  expect(await schemaExists()).toBe(true);
});
