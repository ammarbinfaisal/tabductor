import { afterEach, expect, it } from "vitest";
import { buildAssetToolRegistry, buildToolRegistry, type EmitFn } from "@tabductor/agent";
import type { McpRunClient } from "@tabductor/mcp";
import type { NetworkApi, Page, RunSession } from "@tabductor/browser";
import { newId } from "@tabductor/core";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createTestBlobStore, type TestBlobStore } from "@tabductor/testkit";

/**
 * The §4 security boundary — "browser agent + MCP in one tool registry is the canonical
 * exfiltration chain" — made a test, not a comment. Registry construction touches no I/O for
 * either kind (neither `buildToolRegistry` nor `buildAssetToolRegistry` calls a session/DB
 * method while building the tool list, only when a tool's `execute` runs), so every browser
 * dependency below is a type-satisfying stub that throws if a test bug ever calls it — proof
 * this test asserts the registries' *shape*, not behaviour a live session would need to
 * produce. The asset side's `db`/`blobs` are real (cheap, and `@tabductor/assets`'s own
 * `AssetToolDeps` is a real Drizzle handle's worth of type to fake convincingly) — a future
 * refactor that merges these two registries must fail here, per ROADMAP.md.
 */

let handle: MigratedTestDb | undefined;
let tb: TestBlobStore | undefined;

afterEach(async () => {
  await tb?.drop();
  tb = undefined;
  await handle?.close();
  handle = undefined;
});

function unused(what: string): never {
  throw new Error(`not used in the registry-isolation test: ${what}`);
}

const fakePage: Page = {
  goto: async () => unused("page.goto"),
  click: async () => unused("page.click"),
  type: async () => unused("page.type"),
  waitFor: async () => unused("page.waitFor"),
  queryAll: async () => unused("page.queryAll"),
  probeTarget: async () => unused("page.probeTarget"),
  insertTextRaw: async () => unused("page.insertTextRaw"),
  perceive: async () => unused("page.perceive"),
  scroll: async () => unused("page.scroll"),
  screenshot: async () => unused("page.screenshot"),
  title: async () => unused("page.title"),
  url: () => "http://example.invalid",
  close: async () => unused("page.close"),
};

const fakeNetwork: NetworkApi = {
  list: async () => unused("network.list"),
  body: async () => unused("network.body"),
  read: async () => unused("network.read"),
};

const fakeSession: RunSession = {
  page: fakePage,
  network: fakeNetwork,
  openTab: async () => unused("session.openTab"),
  resolveAnchor: () => undefined,
  close: async () => {},
};

const fakeEmit: EmitFn = async () => unused("emit");

const fakeMcp: McpRunClient = {
  listTools: async () => unused("mcp.listTools"),
  callTool: async () => unused("mcp.callTool"),
  close: async () => {},
};

it("the browser (kind=browser) registry has no mcp.* tool", () => {
  const tools = buildToolRegistry({ session: fakeSession, emit: fakeEmit });
  const names = tools.map((t) => t.name);
  expect(names.some((n) => n.startsWith("mcp."))).toBe(false);
  // The positive control: every tool §4 says a browser node gets, present by name — a suite
  // that only ever checked the negative could pass against an accidentally-empty registry.
  expect(names).toEqual(
    expect.arrayContaining(["page.goto", "page.click", "network.list", "network.read", "emit", "done", "fail"]),
  );
});

it("the asset (kind=asset) registry has no page.*/network.*/secrets.* tool", async () => {
  handle = await createMigratedTestDb();
  tb = await createTestBlobStore();

  const tools = buildAssetToolRegistry({
    emit: fakeEmit,
    assets: { db: handle.db, blobs: tb.store, userId: "user_test", taskId: newId("task"), runId: newId("run") },
    mcp: fakeMcp,
    grantedMcpTools: [
      { server: "fake", tool: { name: "echo", description: "echo", inputSchema: { type: "object" } } },
    ],
  });
  const names = tools.map((t) => t.name);

  expect(names.some((n) => n.startsWith("page."))).toBe(false);
  expect(names.some((n) => n.startsWith("network."))).toBe(false);
  expect(names.some((n) => n.startsWith("secrets."))).toBe(false);
  // The positive control, mirroring the browser test above.
  expect(names).toEqual(
    expect.arrayContaining(["assets.write", "assets.read", "mcp.fake.echo", "emit", "done", "fail"]),
  );
});
