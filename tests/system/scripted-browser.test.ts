import { afterEach, expect, it } from "vitest";
import { cdpEndpoints } from "@tabductor/db";
import { RETRIES_EXHAUSTED, seedWorkflow, updateTask } from "@tabductor/engine";
import { eq } from "drizzle-orm";
import { eventsOfType, runsForTask, trigger, waitFor, waitForQuiet } from "./engine-support.js";
import { startScriptedRig, waitForTraceRows, type ScriptedRig } from "./scripted-support.js";

/**
 * S3b deliverable 6, driven through the ENGINE rather than a bare session (that half —
 * `openSession` directly — is `network-observer.test.ts`/`resource-limits.test.ts`). Every
 * test here goes event → dispatch → `ScriptedBrowserExecutor` → real Chrome → emit, which is
 * the one path none of the Phase 3 unit-ish tests exercise: dispatch resolving the task,
 * the pool's DB-backed lease actually serializing runs, and a script's extracted content
 * surviving all the way into a published event's packet.
 */

let rig: ScriptedRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

it("drives fake-tweets end to end: dispatch -> executor -> extract -> emit, traced", async () => {
  rig = await startScriptedRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Scrape: { mode: "scripted", emits: ["tweets.extracted"] },
    },
    edges: [["Start", "work.requested", "Scrape"]],
  });
  await updateTask(rig.handle.db, {
    taskId: wf.taskIds.Scrape!,
    limits: {
      script: [
        { action: "goto", url: `${rig.fx.url}/fake-tweets` },
        { action: "waitFor", selector: '[data-testid="tweet"]' },
        {
          action: "extract",
          selector: '[data-testid="tweet"]',
          fields: { text: { selector: '[data-testid="tweetText"]' } },
        },
        { action: "emit", type: "tweets.extracted", packetFrom: "lastExtract" },
      ],
    },
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");

  const run = await waitFor("Scrape's run to succeed", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Scrape!);
    return row?.status === "succeeded" ? row : false;
  });
  await waitForQuiet(rig);

  const emitted = await eventsOfType(rig, "tweets.extracted");
  expect(emitted).toHaveLength(1);
  const packet = emitted[0]!.packet as { records: { text: string | null }[] };
  expect(packet.records.map((r) => r.text)).toEqual(
    expect.arrayContaining(["first tweet", "second tweet", "third tweet"]),
  );

  const rows = await waitForTraceRows(rig, run.id, (r) => r.length > 0);
  expect(rows.some((r) => r.kind === "navigation")).toBe(true);
  expect(rows.some((r) => r.kind === "action" && (r.payloadJson as { action?: string }).action === "waitFor")).toBe(
    true,
  );
  expect(rows.some((r) => r.kind === "action" && (r.payloadJson as { action?: string }).action === "queryAll")).toBe(
    true,
  );
  expect(
    rows.some((r) => r.kind === "network" && (r.payloadJson as { url?: string }).url?.endsWith("/api/timeline")),
  ).toBe(true);
});

it("networkBody resolved by urlPattern reaches the packet, through the engine", async () => {
  rig = await startScriptedRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Scrape: { mode: "scripted", emits: ["timeline.body"] },
    },
    edges: [["Start", "work.requested", "Scrape"]],
  });
  await updateTask(rig.handle.db, {
    taskId: wf.taskIds.Scrape!,
    limits: {
      script: [
        { action: "goto", url: `${rig.fx.url}/fake-tweets` },
        { action: "waitFor", selector: '[data-testid="tweet"]' },
        { action: "networkBody", urlPattern: "/api/timeline" },
        { action: "emit", type: "timeline.body", packetFrom: "lastNetworkBody" },
      ],
    },
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");
  const run = await waitFor("Scrape's run to succeed", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Scrape!);
    return row?.status === "succeeded" ? row : false;
  });
  await waitForQuiet(rig);

  const emitted = await eventsOfType(rig, "timeline.body");
  expect(emitted).toHaveLength(1);
  const packet = emitted[0]!.packet as { body: { size: number; text: string } };
  expect(packet.body.size).toBeGreaterThan(0);
  const parsed = JSON.parse(packet.body.text) as { tweets: { text: string }[] };
  expect(parsed.tweets.map((t) => t.text)).toContain("first tweet");

  const rows = await waitForTraceRows(rig, run.id, (r) =>
    r.some((x) => x.kind === "action" && (x.payloadJson as { action?: string }).action === "network.body"),
  );
  const bodyRow = rows.find((r) => (r.payloadJson as { action?: string }).action === "network.body")!;
  expect(bodyRow.payloadJson).toMatchObject({ ok: true, size: packet.body.size });
});

it("aborts on resource_limit_exceeded through the engine, and the failure is permanent", async () => {
  rig = await startScriptedRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Start: {}, Scrape: { mode: "scripted" } },
    edges: [["Start", "work.requested", "Scrape"]],
  });
  await updateTask(rig.handle.db, {
    taskId: wf.taskIds.Scrape!,
    limits: {
      script: [
        { action: "goto", url: `${rig.fx.url}/fake-tweets` },
        { action: "goto", url: `${rig.fx.url}/fake-gram` },
        { action: "goto", url: `${rig.fx.url}/fake-tweets` },
      ],
      browser: { max_visits: 2 },
      // Configured on purpose: a policy present and still not firing is what proves
      // `permanent: true` rather than a lucky absence of one.
      retry: { max: 3, backoff_ms: 10 },
    },
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");
  await waitFor("Scrape's run to fail", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Scrape!);
    return row?.status === "failed" ? row : false;
  });
  await waitForQuiet(rig);

  const attempts = await runsForTask(rig, wf.taskIds.Scrape!);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.error).toBe("resource_limit_exceeded");
  expect(await eventsOfType(rig, RETRIES_EXHAUSTED)).toHaveLength(0);

  const rows = await waitForTraceRows(rig, attempts[0]!.id, (r) =>
    r.some((x) => (x.payloadJson as { limit?: string }).limit === "max_visits"),
  );
  const breach = rows.find((r) => (r.payloadJson as { limit?: string }).limit === "max_visits")!;
  expect(breach.payloadJson).toMatchObject({ action: "goto", ok: false, limit: "max_visits" });
});

it("serializes two runs on one endpoint through the engine: non-overlapping execution windows", async () => {
  rig = await startScriptedRig();
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Start: {}, Scrape: { mode: "scripted", emits: ["scrape.done"] } },
    edges: [["Start", "work.requested", "Scrape"]],
  });
  await updateTask(rig.handle.db, {
    taskId: wf.taskIds.Scrape!,
    limits: {
      script: [
        { action: "goto", url: `${rig.fx.url}/slowpoke?delay_ms=250` },
        { action: "goto", url: `${rig.fx.url}/fake-tweets` },
        { action: "emit", type: "scrape.done" },
      ],
    },
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");
  await trigger(rig, wf.taskIds.Start!, "work.requested");

  await waitFor("both Scrape runs to succeed", async () => {
    const rows = await runsForTask(rig!, wf.taskIds.Scrape!);
    return rows.length === 2 && rows.every((r) => r.status === "succeeded") ? rows : false;
  });
  await waitForQuiet(rig);

  const attempts = await runsForTask(rig, wf.taskIds.Scrape!);
  expect(attempts).toHaveLength(2);
  const windows = await Promise.all(
    attempts.map(async (r) => {
      const rows = await waitForTraceRows(rig!, r.id, (rs) => rs.length > 0);
      return { start: rows[0]!.createdAt.getTime(), end: rows[rows.length - 1]!.createdAt.getTime() };
    }),
  );
  windows.sort((a, b) => a.start - b.start);
  // The pool serializes the endpoint (§8): the later-starting run's first trace entry
  // never lands before the earlier run's last one.
  expect(windows[0]!.end).toBeLessThanOrEqual(windows[1]!.start);
});

it("fails browser.disconnected when Chrome dies mid-run, marks the endpoint unhealthy, and the retry policy applies", async () => {
  const disconnectRig = await startScriptedRig();
  rig = disconnectRig;
  const wf = await seedWorkflow(disconnectRig.handle.db, {
    tasks: { Start: {}, Scrape: { mode: "scripted" } },
    edges: [["Start", "work.requested", "Scrape"]],
  });
  await updateTask(disconnectRig.handle.db, {
    taskId: wf.taskIds.Scrape!,
    limits: {
      script: [{ action: "goto", url: `${disconnectRig.fx.url}/slowpoke?delay_ms=5000` }],
      // One retry, so the second attempt's own `pool.acquire` (against a now-dead wsUrl)
      // is what proves `browser.disconnected` is not permanent, deterministically — no need
      // to race a second live kill to prove the same point.
      retry: { max: 1, backoff_ms: 10 },
    },
  });

  await trigger(disconnectRig, wf.taskIds.Start!, "work.requested");
  await waitFor("Scrape's run to start", async () => {
    const [row] = await runsForTask(disconnectRig, wf.taskIds.Scrape!);
    return row?.status === "running" ? row : false;
  });
  // slowpoke's 5s response gives ample room for the kill to land while `goto` is in flight,
  // whatever the exact scheduling of Chrome's shutdown turns out to be.
  await new Promise((r) => setTimeout(r, 500));
  await disconnectRig.chrome.close();

  const attempts = await waitFor(
    "both attempts to fail with browser.disconnected",
    async () => {
      const rows = await runsForTask(disconnectRig, wf.taskIds.Scrape!);
      return rows.length === 2 && rows.every((r) => r.status === "failed") ? rows : false;
    },
    30_000,
  );
  await waitForQuiet(disconnectRig);

  expect(attempts.every((r) => r.error?.includes("browser.disconnected"))).toBe(true);
  expect(await eventsOfType(disconnectRig, RETRIES_EXHAUSTED)).toHaveLength(1);

  const disconnectEvents = await eventsOfType(disconnectRig, "browser.disconnected");
  expect(disconnectEvents).toHaveLength(1);

  const [endpointRow] = await disconnectRig.handle.db
    .select()
    .from(cdpEndpoints)
    .where(eq(cdpEndpoints.id, disconnectRig.endpointId));
  expect(endpointRow?.healthy).toBe(false);
});
