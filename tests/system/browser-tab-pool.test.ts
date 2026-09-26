import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newId } from "@tabductor/core";
import { browserSessions, browserWorkers, browserAllocationRequests, browserTabLeases, runs, workflowExecutions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflow, publishVersion, staticSchemaGenerator, createWorkflowExecution, resolveAccountIdentity,
  createHostedBrowserPool, claimBrowserAllocation, fulfillBrowserAllocation, stopFinishedExecutionBrowsers,
  browserTabKey, claimBrowserTab, releaseBrowserTab, assertBrowserTabLease, ensureExecutionBrowserSession,
  ensureWorkflowBrowserProfile, cancelRun, requestBrowserTakeover, acknowledgeBrowserPause, resumeBrowserAutomation, acknowledgeBrowserResume } from "@tabductor/engine";
import { eq } from "drizzle-orm";
import { withAutomationControl } from "@tabductor/browser";
import { createCaller } from "../../apps/web/src/server/router.js";

let handle: MigratedTestDb;
beforeEach(async () => { handle = await createMigratedTestDb(); });
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await handle?.close(); });

async function fixture() {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "tabs" });
  const workflowId = await createWorkflow(handle.db, { accountId, name: "X to Notion", userId: "fixture" });
  const version = await publishVersion(handle.db, { workflowId, graph: { tasks: [
    { name: "extract", kind: "browser", mode: "ai", prompt: "Extract", emits: [], consumes: [], limits: {}, schedule: null, position: null },
    { name: "write", kind: "browser", mode: "ai", prompt: "Write", emits: [], consumes: [], limits: { browser: { tab_key: "notion" } }, schedule: null, position: null },
    { name: "verify", kind: "browser", mode: "ai", prompt: "Verify", emits: [], consumes: [], limits: { browser: { tab_key: "notion" } }, schedule: null, position: null },
  ], events: [] } }, { schemaGenerator: staticSchemaGenerator() });
  const executionId = await createWorkflowExecution(handle.db, { workflowId });
  const profileId = await ensureWorkflowBrowserProfile(handle.db, accountId, workflowId);
  const run = async (name: string) => {
    const id = newId("run");
    await handle.db.insert(runs).values({ id, executionId, taskId: version.taskIds[name]!, workflowVersionId: version.versionId,
      modeUsed: "ai", status: "running", leaseGeneration: 1 });
    return id;
  };
  return { accountId, executionId, profileId, version, run };
}

it("serves many packet runs on two retained tabs in one browser, across pool instances", async () => {
  const f = await fixture();
  const slots = new Map<string, { page_id: string; url: string }>();
  const pending: Array<() => void> = [];
  let overlap = 0;
  const request: typeof fetch = async (_url, init) => {
    const command = JSON.parse(String(init?.body));
    if (command.method === "tab.acquire") {
      const key = command.params.tab_key;
      if (!slots.has(key)) slots.set(key, { page_id: `p${slots.size + 1}`, url: "about:blank" });
      return Response.json({ value: slots.get(key) });
    }
    if (command.method === "page.goto") {
      overlap++;
      await new Promise<void>(resolve => { pending.push(resolve); if (pending.length === 2) pending.splice(0).forEach(done => done()); });
      const slot = [...slots.values()].find(page => page.page_id === command.page_id)!;
      slot.url = command.params.url;
    }
    return Response.json({ value: command.method === "browser.version" ? "fixture" : null });
  };
  const deps = { db: handle.db, tokenKey: "x".repeat(32), workerUrl: async () => "http://worker", fetch: request };
  const a = createHostedBrowserPool(deps), b = createHostedBrowserPool(deps);
  try {
    const first = a.acquire("", await f.run("extract"));
    const second = b.acquire("", await f.run("write"));
    await vi.waitFor(async () => { expect(await handle.db.select().from(browserSessions)).toHaveLength(1); });
    const allocation = (await claimBrowserAllocation(handle.db))!;
    await fulfillBrowserAllocation(handle.db, { ...allocation, workerId: "worker", podName: "worker" });
    const [extractor, writer] = await Promise.all([first, second]);
    const [x, notion] = await Promise.all([extractor.conn.createPage(), writer.conn.createPage()]);
    expect(x.id).not.toBe(notion.id);
    await Promise.all([x.goto("https://x.com"), notion.goto("https://app.notion.com")]);
    expect(overlap).toBe(2); // Both HTTP effects entered before either could finish.
    let nextReady = false;
    const waiting = a.acquire("", await f.run("verify")).then(lease => { nextReady = true; return lease; });
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(nextReady).toBe(false);
    await notion.close(); await writer.release();
    const next = await waiting;
    const reused = await next.conn.createPage();
    expect(reused.id).toBe(notion.id);
    expect(reused.url()).toBe("https://app.notion.com");
    await next.release();
    for (let n = 0; n < 5; n++) {
      const packet = await b.acquire("", await f.run("write"));
      expect((await packet.conn.createPage()).id).toBe(notion.id);
      await packet.release();
    }
    expect(slots.size).toBe(2);
    expect(await handle.db.select().from(browserSessions)).toHaveLength(1);
    expect(await handle.db.select().from(browserAllocationRequests)).toHaveLength(1);
    expect(await extractor.conn.version()).toBe("fixture");
    expect(await stopFinishedExecutionBrowsers(handle.db)).toBe(0);
    await extractor.release();
    await handle.db.update(workflowExecutions).set({ status: "succeeded" }).where(eq(workflowExecutions.id, f.executionId));
    expect(await stopFinishedExecutionBrowsers(handle.db)).toBe(1);
    expect((await handle.db.select().from(browserSessions))[0]!.status).toBe("stopping");
  } finally { pending.splice(0).forEach(done => done()); await a.close(); await b.close(); }
});

it("reclaims cancelled owners and fences stale releases and commands", async () => {
  const f = await fixture();
  const input = { accountId: f.accountId, profileId: f.profileId, executionId: f.executionId };
  const ids = await Promise.all(Array.from({ length: 5 }, () => ensureExecutionBrowserSession(handle.db, input)));
  expect(new Set(ids).size).toBe(1);
  const sessionId = ids[0]!;
  const allocation = (await claimBrowserAllocation(handle.db))!;
  await fulfillBrowserAllocation(handle.db, { ...allocation, workerId: "worker", podName: "worker" });
  const old = { sessionId, tabKey: "notion", runId: await f.run("write"), runGeneration: 1, taskId: f.version.taskIds.write! };
  const next = { ...old, runId: await f.run("verify") };
  expect(await claimBrowserTab(handle.db, old)).toBe(true);
  expect(await claimBrowserTab(handle.db, next)).toBe(false);
  await cancelRun(handle.db, old.runId);
  expect(await claimBrowserTab(handle.db, next)).toBe(true);
  await releaseBrowserTab(handle.db, old);
  await expect(handle.db.transaction(trx => assertBrowserTabLease(trx, old))).rejects.toMatchObject({ code: "browser_tab_lease_lost" });
  expect((await handle.db.select().from(browserTabLeases))[0]!.runId).toBe(next.runId);
  expect(browserTabKey({ id: "extract", limitsJson: {} })).toBe("extract");
  expect(() => browserTabKey({ id: "extract", limitsJson: { browser: { tab_key: "" } } })).toThrow();
  await releaseBrowserTab(handle.db, next);
  await handle.db.update(browserSessions).set({ inputOwner: "human" }).where(eq(browserSessions.id, sessionId));
  expect(await claimBrowserTab(handle.db, next)).toBe(false);
});

it("lists task ownership and selects tabs only for the owning account", async () => {
  const f = await fixture();
  const sessionId = await ensureExecutionBrowserSession(handle.db, f);
  const allocation = (await claimBrowserAllocation(handle.db))!;
  await fulfillBrowserAllocation(handle.db, { ...allocation, workerId: "worker", podName: "worker" });
  await handle.db.update(browserWorkers).set({ endpointUrl: "http://worker" }).where(eq(browserWorkers.id, "worker"));
  const runId = await f.run("write");
  await claimBrowserTab(handle.db, { sessionId, tabKey: "notion", runId, runGeneration: 1, taskId: f.version.taskIds.write! });
  vi.stubEnv("BROWSER_WORKER_TOKEN_KEY", "x".repeat(32));
  const rpc = vi.fn(async (url: string) => Response.json(url.endsWith("/tabs/select") ? { selected: true } : {
    tabs: [{ pageId: "p2", title: "Notion database", url: "https://app.notion.com/db", selected: false, tabKey: "notion" }],
  }));
  vi.stubGlobal("fetch", rpc);
  const caller = (accountId: string) => createCaller({ db: handle.db, pool: handle.pool, accountId, schemaGenerator: staticSchemaGenerator() });
  const owner = caller(f.accountId);
  expect((await owner.browserSession.list()).items[0]?.workflowName).toBe("X to Notion");
  expect((await owner.browserSession.get({ sessionId })).name).toBe("X to Notion");
  expect(await owner.browserSession.tabs({ sessionId })).toEqual([
    { pageId: "p2", title: "Notion database", url: "https://app.notion.com/db", selected: false, tabKey: "notion", runId, taskName: "write" },
  ]);
  expect(await owner.browserSession.selectTab({ sessionId, pageId: "p2" })).toEqual({ selected: true });
  expect(rpc.mock.calls[1]![0]).toBe(`http://worker/v1/sessions/${sessionId}/tabs/select`);
  const stranger = caller(await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "stranger" }));
  await expect(stranger.browserSession.tabs({ sessionId })).rejects.toThrow();
  await expect(stranger.browserSession.selectTab({ sessionId, pageId: "p2" })).rejects.toThrow();
  expect(rpc).toHaveBeenCalledTimes(2);
});

it("keeps initialization paused until the worker acknowledges resume and still requires fresh perception", async () => {
  const f = await fixture();
  const sessionId = await ensureExecutionBrowserSession(handle.db, f);
  const allocation = (await claimBrowserAllocation(handle.db))!;
  await fulfillBrowserAllocation(handle.db, { ...allocation, workerId: "worker", podName: "worker" });
  const request = vi.fn(async (_url, init) => {
    const command = JSON.parse(String(init?.body));
    return Response.json({ value: command.method === "browser.version" ? "fixture" : command.method === "tab.acquire"
      ? {page_id: "p1"} : {url:"https://fixture.test", title:"", text:"", elements:[]} });
  });
  const pool = createHostedBrowserPool({ db: handle.db, tokenKey: "x".repeat(32), workerUrl: async () => "http://worker", fetch: request });
  try {
    const lease = await pool.acquire("", await f.run("write"));
    const page = await lease.conn.createPage();
    request.mockClear();
    const paused = await requestBrowserTakeover(handle.db, { accountId: f.accountId, sessionId });
    await acknowledgeBrowserPause(handle.db, { sessionId, generation: paused.generation, inputOwnerGeneration: paused.inputOwnerGeneration });
    let initialized = false;
    const initialization = withAutomationControl(lease.conn, () => lease.conn.version()).then(version => { initialized = true; return version; });
    const resumed = await resumeBrowserAutomation(handle.db, { accountId: f.accountId, sessionId });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(initialized).toBe(false);
    expect(request).not.toHaveBeenCalled();
    await acknowledgeBrowserResume(handle.db, { sessionId, generation: resumed.generation, inputOwnerGeneration: resumed.inputOwnerGeneration });
    expect(await initialization).toBe("fixture");
    await expect(page.click("button")).rejects.toMatchObject({ code: "browser_fresh_perception_required" });
    await page.perceive();
    await expect(page.click("button")).resolves.toBeDefined();
    expect(request.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).input_generation === resumed.inputOwnerGeneration)).toBe(true);
    await lease.release();
  } finally { await pool.close(); }
});
