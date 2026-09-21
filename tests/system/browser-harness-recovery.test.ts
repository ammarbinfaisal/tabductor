import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchChrome, type Chrome } from "@tabductor/testkit";
import { openRunSession, playwrightDriver, type BrowserConn, type RunSession, type TraceRecorder } from "@tabductor/browser";
import { AllowAllGate } from "@tabductor/policy";
import { buildToolRegistry } from "@tabductor/agent";

let chrome: Chrome;
let conn: BrowserConn;
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<main role="main"><h1>${req.url === "/a" ? "Alpha" : "Beta"}</h1><article>Initial timeline content</article><button onclick="document.querySelector('article').textContent='Fresh tweets are visible'">Update</button></main><a href="#" style="visibility:hidden">Skip to content</a>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
  chrome = await launchChrome();
  conn = await playwrightDriver.connect(chrome.wsUrl);
});
afterAll(async () => {
  await conn?.close(); await chrome?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function recorder() {
  const rows: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const trace: TraceRecorder = { record: async (kind, payload) => { rows.push({ kind, payload }); }, flush: async () => {}, close: async () => {} };
  return { trace, rows };
}

it("keeps concurrent sessions in different browser targets and traces their own tab IDs", async () => {
  const first = recorder(); const second = recorder();
  const gate = new AllowAllGate({ navAllowlist: ["127.0.0.1"] });
  const [a, b] = await Promise.all([
    openRunSession({ conn, gate, trace: first.trace, taskCtx: { runId: "run_a", taskId: "task_a" } }),
    openRunSession({ conn, gate, trace: second.trace, taskCtx: { runId: "run_b", taskId: "task_b" } }),
  ]);
  try {
    expect(a.page.id).toBeTruthy(); expect(b.page.id).toBeTruthy(); expect(a.page.id).not.toBe(b.page.id);
    await Promise.all([a.page.goto(`${origin}/a`), b.page.goto(`${origin}/b`)]);
    await a.page.click("button");
    expect((await a.page.perceive()).text).toContain("Fresh tweets");
    expect((await b.page.perceive()).text).toContain("Beta");
    expect((await b.page.perceive()).text).not.toContain("Fresh tweets");
    expect(first.rows.filter((r) => r.kind === "action").every((r) => r.payload.pageId === a.page.id)).toBe(true);
    expect(second.rows.filter((r) => r.kind === "action").every((r) => r.payload.pageId === b.page.id)).toBe(true);
    await a.close();
    expect((await b.page.perceive()).url).toBe(`${origin}/b`);
  } finally { await a.close(); await b.close(); }
});

it("keeps a main anchor valid when its timeline changes and excludes hidden skip links", async () => {
  const page = await conn.createPage({ onNavigationRequest: async () => true });
  try {
    await page.goto(`${origin}/a`);
    const before = await page.perceive();
    const main = before.elements.find((e) => e.role === "main")!;
    expect(main.locator).not.toContain("text-is");
    expect(before.elements.some((e) => e.text === "Skip to content")).toBe(false);
    await page.click("button");
    await page.waitFor(main.locator, { state: "visible", timeout: 500 });
    expect((await page.queryAll(main.locator, { content: {} }))[0]?.content).toContain("Fresh tweets");
  } finally { await page.close(); }
});

it("returns fresh perception after a failed wait and requires exploration before reporting unavailability", async () => {
  const waitFor = vi.fn(async () => { throw new Error("Timeout waiting for old anchor"); });
  const emit = vi.fn(async () => ({ outcome: "deduped" as const }));
  const session = {
    page: { waitFor, perceive: async () => ({ url: "https://x.com/home", title: "Home", text: "Fresh tweets are visible", elements: [] }), queryAll: async () => [{ text: "A tweet" }] },
    resolveAnchor: () => "main:text-is(\"old timeline\")",
  } as unknown as RunSession;
  const tools = new Map(buildToolRegistry({ session, emit }).map((t) => [t.name, t]));
  const failed = await tools.get("page.waitFor")!.execute({ anchor: "e29" });
  expect(failed).toMatchObject({ ok: false, value: expect.objectContaining({text:"Fresh tweets are visible"}) });
  expect(await tools.get("emit")!.execute({ type: "x.page_unavailable", packet: {} })).toMatchObject({ ok: false });
  expect(emit).not.toHaveBeenCalled();
  expect(await tools.get("page.waitFor")!.execute({ anchor: "e29" })).toMatchObject({ ok: false, error: expect.stringContaining("same wait") });
  expect(waitFor).toHaveBeenCalledTimes(1);
  expect(await tools.get("page.perceive")!.execute({})).toMatchObject({ ok: true });
  expect(await tools.get("page.extract")!.execute({ fields: { text: {} } })).toMatchObject({ ok: true });
  expect(await tools.get("emit")!.execute({ type: "tweets.collected", packet: {} })).toMatchObject({ ok: true });
  expect(emit).toHaveBeenCalledTimes(1);
});
