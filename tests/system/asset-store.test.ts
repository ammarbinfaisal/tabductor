import { afterEach, expect, it } from "vitest";
import { newId } from "@tabductor/core";
import { assets, assetVersions, assetWriteGrants } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { buildAssetToolRegistry, type AssetTool, type AssetToolDeps, type AssetToolResult } from "@tabductor/assets";
import { seedWorkflow, validatePacket } from "@tabductor/engine";
import { createTestBlobStore, type TestBlobStore } from "@tabductor/testkit";
import { eq } from "drizzle-orm";

/**
 * The asset store (S5d): `assets.write/append/read/list`, write-grant enforcement, and the
 * asset-ref fragment round-tripping through a compiled packet schema.
 *
 * Tools are called directly rather than through a live agent loop — S5c is what wires
 * `assets.*` into a real `(asset, ai)` run (`tools.ts`'s own doc comment says so). What is
 * under test here is the registry's behaviour, which does not need one.
 */

let handle: MigratedTestDb | undefined;
let tb: TestBlobStore | undefined;

afterEach(async () => {
  await tb?.drop();
  tb = undefined;
  await handle?.close();
  handle = undefined;
});

const USER = "user_test";

async function setup(): Promise<{ deps: AssetToolDeps; taskId: string; tools: AssetTool[] }> {
  handle = await createMigratedTestDb();
  tb = await createTestBlobStore();
  const wf = await seedWorkflow(handle.db, { userId: USER, tasks: { A: { kind: "asset", mode: "ai" } } });
  const taskId = wf.taskIds.A!;
  const deps: AssetToolDeps = { db: handle.db, blobs: tb.store, userId: USER, taskId, runId: newId("run") };
  return { deps, taskId, tools: buildAssetToolRegistry(deps) };
}

function tool(tools: AssetTool[], name: string): AssetTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool "${name}"`);
  return t;
}

function okValue(result: AssetToolResult): unknown {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}

it("writes and reads a text asset back", async () => {
  const { tools } = await setup();
  const written = await tool(tools, "assets.write").execute({
    path: "reports/one.md",
    content: "# hello",
    mime: "text/markdown",
  });
  expect(written.ok).toBe(true);
  expect(okValue(written)).toMatchObject({ path: "/reports/one.md", version: 1, mime: "text/markdown" });

  const read = await tool(tools, "assets.read").execute({ path: "reports/one.md" });
  expect(read.ok).toBe(true);
  const wrapped = okValue(read) as string;
  expect(wrapped).toContain("UNTRUSTED_DATA");
  expect(wrapped).toContain("# hello");
});

it("an overwrite creates a new asset_versions row, bumps current_version, and never destroys the prior blob", async () => {
  const { tools } = await setup();
  const write = tool(tools, "assets.write");

  const first = okValue(await write.execute({ path: "reports/two.md", content: "v1", mime: "text/markdown" })) as {
    version: number;
  };
  const second = okValue(await write.execute({ path: "reports/two.md", content: "v2", mime: "text/markdown" })) as {
    version: number;
  };
  expect(second.version).toBe(first.version + 1);

  const [row] = await handle!.db.select().from(assets).where(eq(assets.path, "/reports/two.md"));
  expect(row?.currentVersion).toBe(second.version);

  const versions = await handle!.db.select().from(assetVersions).where(eq(assetVersions.assetId, row!.id));
  expect(versions).toHaveLength(2);

  // The property under test: the *old* version's blob still resolves through BlobStore,
  // proving "overwrites never destroy the prior blob" rather than asserting it.
  const oldVersion = versions.find((v) => v.version === first.version)!;
  const oldBytes = await tb!.store.get(oldVersion.blobRef);
  expect(oldBytes.toString("utf8")).toBe("v1");

  const newVersion = versions.find((v) => v.version === second.version)!;
  const newBytes = await tb!.store.get(newVersion.blobRef);
  expect(newBytes.toString("utf8")).toBe("v2");
});

it("assets.append accumulates onto existing content as a new version", async () => {
  const { tools } = await setup();
  await tool(tools, "assets.write").execute({ path: "logs/run.log", content: "line1\n", mime: "text/plain" });
  const appended = await tool(tools, "assets.append").execute({ path: "logs/run.log", content: "line2\n" });
  expect(appended.ok).toBe(true);
  expect(okValue(appended)).toMatchObject({ version: 2 });

  const read = okValue(await tool(tools, "assets.read").execute({ path: "logs/run.log" })) as string;
  expect(read).toContain("line1");
  expect(read).toContain("line2");
});

it("assets.append creates the asset (empty-first) when it does not exist yet", async () => {
  const { tools } = await setup();
  const appended = await tool(tools, "assets.append").execute({ path: "logs/fresh.log", content: "only line\n" });
  expect(appended.ok).toBe(true);
  expect(okValue(appended)).toMatchObject({ version: 1 });
});

it("assets.list matches by glob, scoped to this caller's user", async () => {
  const { tools } = await setup();
  await tool(tools, "assets.write").execute({ path: "reports/a.md", content: "a", mime: "text/markdown" });
  await tool(tools, "assets.write").execute({ path: "data/b.csv", content: "b", mime: "text/csv" });

  const result = okValue(await tool(tools, "assets.list").execute({ glob: "/reports/**" })) as {
    assets: Array<{ path: string }>;
  };
  expect(result.assets.map((a) => a.path)).toEqual(["/reports/a.md"]);

  const everything = okValue(await tool(tools, "assets.list").execute({})) as { assets: Array<{ path: string }> };
  expect(everything.assets.map((a) => a.path).sort()).toEqual(["/data/b.csv", "/reports/a.md"]);
});

it("a task with no asset_write_grants rows may write anywhere under its own namespace", async () => {
  const { tools } = await setup();
  const result = await tool(tools, "assets.write").execute({
    path: "anywhere/x.md",
    content: "ok",
    mime: "text/markdown",
  });
  expect(result.ok).toBe(true);
});

it("write outside an existing grant glob is denied; a matching path still succeeds", async () => {
  const { tools, taskId } = await setup();
  await handle!.db.insert(assetWriteGrants).values({ taskId, pathGlob: "/reports/**" });

  const denied = await tool(tools, "assets.write").execute({
    path: "secrets/x.txt",
    content: "no",
    mime: "text/plain",
  });
  expect(denied.ok).toBe(false);

  const allowed = await tool(tools, "assets.write").execute({
    path: "reports/x.md",
    content: "yes",
    mime: "text/markdown",
  });
  expect(allowed.ok).toBe(true);

  // The denied write never reached the store or the table.
  const rows = await handle!.db.select().from(assets).where(eq(assets.path, "/secrets/x.txt"));
  expect(rows).toHaveLength(0);
});

it("a traversal payload is rejected before it ever reaches BlobStore", async () => {
  const { tools } = await setup();
  const result = await tool(tools, "assets.write").execute({
    path: "../../etc/passwd",
    content: "pwned",
    mime: "text/plain",
  });
  expect(result.ok).toBe(false);
  expect(await tb!.list()).toEqual([]);
});

it(
  "an asset ref round-trips through a compiled packet schema via the registered assetRef fragment",
  async () => {
    handle = await createMigratedTestDb();
    const schema = {
      type: "object",
      properties: { report: { $ref: "assetRef" } },
      required: ["report"],
      additionalProperties: false,
    };

    const wf = await seedWorkflow(handle.db, {
      userId: USER,
      tasks: { A: { kind: "asset", mode: "ai", emits: ["report.ready"] } },
      events: { "report.ready": { schema } },
    });

    const good = {
      report: { asset_id: newId("asset"), path: "/reports/x.pdf", mime: "application/pdf", sha256: "a".repeat(64) },
    };
    const okCheck = await validatePacket(handle.db, wf.taskIds.A!, "report.ready", good);
    expect(okCheck.ok).toBe(true);

    const bad = { report: { asset_id: "only-this-field" } };
    const badCheck = await validatePacket(handle.db, wf.taskIds.A!, "report.ready", bad);
    expect(badCheck.ok).toBe(false);
  },
);
