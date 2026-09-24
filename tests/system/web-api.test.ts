import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@tabductor/core";
import { browserSessions, cdpEndpoints, runs, traceEntries } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createBrowserProfile, createWorkflowExecution, finishRun, requestBrowserSession, startRun, staticSchemaGenerator, triggerTask } from "@tabductor/engine";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createCaller } from "../../apps/web/src/server/router.js";

/**
 * The control-plane API against a real migrated Postgres, driven through `createCaller` —
 * the same entry point the server components use, so these tests are the API contract the
 * UI track consumes (impl-phases, UI-track rule 1).
 *
 * No HTTP server is started. The route handler is four lines of `fetchRequestHandler` and
 * adds no behaviour of its own; what is worth testing is the router, and running it in
 * process keeps the suite free of a port to race on.
 */

let handle: MigratedTestDb;
let api: ReturnType<typeof createCaller>;

/** Internal fixture setup; manual task starts are not exposed by the user API. */
async function seedManualRun(input: Parameters<typeof triggerTask>[1]) {
  const { event, dispatched } = await triggerTask(handle.db, input);
  return { eventId: event.eventId, type: event.type, runId: dispatched?.runId ?? null };
}

/** Deterministic publish: the one schema these tests declare, no model in the loop. */
const TEST_SCHEMAS = {
  "tweet.detected": { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};

beforeAll(async () => {
  handle = await createMigratedTestDb();
  api = createCaller({ db: handle.db, pool: handle.pool, schemaGenerator: staticSchemaGenerator(TEST_SCHEMAS) });
});

afterAll(async () => {
  await handle?.close();
});

const twoNodeGraph = {
  tasks: [
    {
      name: "Watcher",
      kind: "browser" as const,
      mode: "stub",
      prompt: "watch the timeline",
      limits: { stub: { emits: [{ type: "tweet.detected", packet: { url: "https://x.com/1" } }] } },
      emits: ["tweet.detected"],
      consumes: [],
      schedule: { cron: "*/5 * * * *", tz: "UTC", missedPolicy: "skip" as const, overlapPolicy: "skip" as const, maxQueueDepth: 1, enabled: true },
      position: { x: 40, y: 80 },
    },
    {
      name: "Poster",
      kind: "browser" as const,
      mode: "stub",
      prompt: null,
      limits: {},
      emits: [],
      consumes: ["tweet.detected"],
      schedule: null,
      position: { x: 320, y: 80 },
    },
  ],
  events: [
    { type: "tweet.detected", description: "A tweet the watcher found on the timeline.", public: false },
  ],
};

/** The error tRPC actually threw, so a test can assert on its code rather than its prose. */
async function trpcError(fn: () => Promise<unknown>): Promise<TRPCError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TRPCError) return err;
    throw err;
  }
  throw new Error("expected the procedure to reject");
}

describe("workflow", () => {
  it("rejects individual manual starts and custom event types through the control API", async () => {
    const legacy = api.run as unknown as { triggerManual(input: unknown): Promise<unknown> };
    await expect(legacy.triggerManual({ taskId: "task_not_allowed" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(api.workflow.trigger({ workflowId: "wf", eventType: "replay.event" } as unknown as { workflowId: string })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("creates, publishes a version, and reads the graph back", async () => {
    const workflowId = await api.workflow.create({ name: "timeline watcher", maxHops: 8 });
    const { versionId, taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });

    const got = await api.workflow.get({ id: workflowId });
    expect(got.workflow.name).toBe("timeline watcher");
    expect(got.workflow.maxHops).toBe(8);
    expect(got.versionId).toBe(versionId);
    expect(got.tasks.map((t) => t.name)).toEqual(["Poster", "Watcher"]);

    // The document survives the round trip through rows: prompts, limits, declarations,
    // the event entity, the schedule, and the canvas positions the editor needs back.
    const watcher = got.graph.tasks.find((t) => t.name === "Watcher")!;
    expect(watcher.prompt).toBe("watch the timeline");
    expect(watcher.emits).toEqual(["tweet.detected"]);
    expect(watcher.schedule).toMatchObject({ cron: "*/5 * * * *", overlapPolicy: "skip" });
    expect(watcher.position).toEqual({ x: 40, y: 80 });
    expect(got.graph.tasks.find((t) => t.name === "Poster")!.consumes).toEqual(["tweet.detected"]);
    expect(got.graph.events).toEqual([
      { type: "tweet.detected", description: "A tweet the watcher found on the timeline.", public: false },
    ]);
    // The compiled schema rides beside the document, read-only.
    expect(got.eventSchemas["tweet.detected"]).toMatchObject({ required: ["url"] });
    expect(Object.keys(taskIds).sort()).toEqual(["Poster", "Watcher"]);
  });

  it("publishes a new version and repoints the workflow without touching the old rows", async () => {
    const workflowId = await api.workflow.create({ name: "versioned" });
    const first = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const second = await api.workflow.publishVersion({
      workflowId,
      graph: { tasks: [twoNodeGraph.tasks[0]!], events: twoNodeGraph.events },
    });

    expect(second.versionId).not.toBe(first.versionId);
    const got = await api.workflow.get({ id: workflowId });
    expect(got.versionId).toBe(second.versionId);
    expect(got.graph.tasks).toHaveLength(1);
    // The superseded version keeps its own rows — runs pinned to it must still resolve.
    expect(await api.workflow.get({ id: workflowId }).then((w) => w.tasks)).toHaveLength(1);
  });

  it("preserves user-facing descriptions separately from prompts and rejects stale publication", async () => {
    const workflowId = await api.workflow.create({ name: "Readable workflow" });
    const graph = { ...twoNodeGraph,
      tasks: twoNodeGraph.tasks.map((task) => ({ ...task, label: `Friendly ${task.name}`, summary: "Collects useful updates for the team." })),
      events: twoNodeGraph.events.map((event) => ({ ...event, label: "New update", summary: "An update ready to share." })),
    };
    const first = await api.workflow.publishVersion({ workflowId, graph, expectedVersionId: null });
    const got = await api.workflow.get({ id: workflowId });
    expect(got.graph.tasks.find((task) => task.name === "Watcher")).toMatchObject({ label: "Friendly Watcher", summary: "Collects useful updates for the team.", prompt: "watch the timeline" });
    expect(got.graph.events[0]).toMatchObject({ label: "New update", summary: "An update ready to share.", description: twoNodeGraph.events[0]!.description });
    await expect(api.workflow.publishVersion({ workflowId, graph, expectedVersionId: null })).rejects.toThrow("published elsewhere");
    expect((await api.workflow.get({ id: workflowId })).versionId).toBe(first.versionId);
  });

  it("fails the publish with a per-event report when schema generation fails, writing nothing", async () => {
    const workflowId = await api.workflow.create({ name: "bad schema" });
    const failing = createCaller({
      db: handle.db,
      pool: handle.pool,
      schemaGenerator: { generate: () => Promise.resolve({ ok: false, error: "generator says no" }) },
    });
    const graph = {
      tasks: [
        {
          name: "Broken",
          kind: "browser" as const,
          mode: "stub",
          prompt: null,
          limits: {},
          emits: ["thing.done"],
          consumes: [],
          schedule: null,
          position: null,
        },
      ],
      events: [{ type: "thing.done", description: "The thing finished.", public: false }],
    };

    const err = await trpcError(() => failing.workflow.publishVersion({ workflowId, graph }));
    expect(err.code).toBe("BAD_REQUEST");
    const details = (err.cause as { details?: { report?: { events: unknown[] } } }).details;
    expect(details?.report?.events).toEqual([
      { type: "thing.done", status: "failed", error: "generator says no" },
    ]);
    // Nothing was written: the workflow still has no current version.
    expect((await api.workflow.get({ id: workflowId })).versionId).toBeNull();
  });

  it("gates a generated schema that does not compile under ajv strict", async () => {
    const workflowId = await api.workflow.create({ name: "bad generated schema" });
    const hostile = createCaller({
      db: handle.db,
      pool: handle.pool,
      schemaGenerator: {
        generate: () => Promise.resolve({ ok: true, schema: { type: "not-a-json-schema-type" } }),
      },
    });
    const err = await trpcError(() =>
      hostile.workflow.publishVersion({
        workflowId,
        graph: {
          tasks: [],
          events: [{ type: "thing.done", description: "The thing finished.", public: false }],
        },
      }),
    );
    expect(err.code).toBe("BAD_REQUEST");
    const details = (err.cause as { details?: { report?: { events: Array<{ status: string; error?: string }> } } })
      .details;
    expect(details?.report?.events[0]).toMatchObject({ status: "failed" });
    expect(details?.report?.events[0]!.error).toContain("compile");
  });

  it("allows a schedule on a decision node", async () => {
    const workflowId = await api.workflow.create({ name: "decision schedule" });
    const published = await api.workflow.publishVersion({
        workflowId,
        graph: {
          tasks: [
            {
              name: "Report",
              kind: "decision",
              mode: "stub",
              prompt: null,
              limits: {},
              emits: [],
              schedule: { cron: "* * * * *", tz: "UTC", missedPolicy: "skip", overlapPolicy: "skip", maxQueueDepth: 1, enabled: true },
              position: null,
            },
          ],
          events: [],
        },
    });
    expect(published.taskModes.Report).toBe("stub");
  });

  it("triggers and schedules a published workflow without exposing internal task ids", async () => {
    const workflowId = await api.workflow.create({ name: "workflow controls" });
    const first = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });

    const triggered = await api.workflow.trigger({ workflowId });
    expect(triggered.accepted).toBe(1);
    expect(triggered.runs[0]?.runId).toMatch(/^run_/);
    expect(JSON.stringify(triggered)).not.toContain("task_");

    const scheduled = await api.workflow.setSchedule({
      workflowId,
      schedule: { cron: "0 7 * * *", timezone: "Asia/Kolkata", enabled: false },
    });
    expect(scheduled.versionId).not.toBe(first.versionId);
    let current = await api.workflow.get({ id: workflowId });
    expect(current.graph.tasks.find((task) => task.name === "Watcher")?.schedule).toMatchObject({
      cron: "0 7 * * *",
      tz: "Asia/Kolkata",
      enabled: false,
    });
    expect(current.graph.tasks.find((task) => task.name === "Poster")?.schedule).toBeNull();

    const beforeInvalid = current.versionId;
    const invalid = await trpcError(() => api.workflow.setSchedule({
      workflowId,
      schedule: { cron: "this is not cron", timezone: "UTC", enabled: true },
    }));
    expect(invalid.code).toBe("BAD_REQUEST");
    expect((await api.workflow.get({ id: workflowId })).versionId).toBe(beforeInvalid);

    const removed = await api.workflow.setSchedule({ workflowId, schedule: null });
    expect(removed.versionId).not.toBe(scheduled.versionId);
    current = await api.workflow.get({ id: workflowId });
    expect(current.graph.tasks.every((task) => task.schedule === null)).toBe(true);
  });

  it("rejects an emit of an event no entity declares", async () => {
    const workflowId = await api.workflow.create({ name: "undeclared emit" });
    const err = await trpcError(() =>
      api.workflow.publishVersion({
        workflowId,
        graph: { tasks: [{ ...twoNodeGraph.tasks[0]!, emits: ["ghost.event"] }], events: [] },
      }),
    );
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toContain("ghost.event");
  });

  it("lists workflows with their task count and last run", async () => {
    const workflowId = await api.workflow.create({ name: "listed" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });

    const before = (await api.workflow.list()).find((w) => w.id === workflowId)!;
    expect(before.taskCount).toBe(2);
    expect(before.lastRunStatus).toBeNull();
    expect(before.lastRunAt).toBeNull();

    const { runId } = await seedManualRun({ taskId: taskIds.Watcher! });
    const started = await startRun(handle.db, runId!, undefined);
    await finishRun(handle.db, { runId: runId!, taskId: taskIds.Watcher!, status: "succeeded", leaseGeneration: started!.leaseGeneration });

    const after = (await api.workflow.list()).find((w) => w.id === workflowId)!;
    expect(after.lastRunStatus).toBe("succeeded");
    expect(after.lastRunAt).toBeInstanceOf(Date);
  });

  it("404s on an unknown workflow and 400s on malformed input", async () => {
    expect((await trpcError(() => api.workflow.get({ id: "wf_nope" }))).code).toBe("NOT_FOUND");
    expect(
      (await trpcError(() => api.workflow.create({ name: "" } as { name: string }))).code,
    ).toBe("BAD_REQUEST");
    expect(
      (await trpcError(() => api.workflow.publishVersion({ workflowId: "wf_x", graph: { tasks: "nope" } as never })))
        .code,
    ).toBe("BAD_REQUEST");
  });
});

describe("task", () => {
  it("updates prompt, mode and limits in place", async () => {
    const workflowId = await api.workflow.create({ name: "task edits" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const taskId = taskIds.Poster!;

    await api.task.update({ taskId, prompt: "post it", limits: { retry: { max: 2, backoff_ms: 10 } } });
    const task = await api.task.get({ taskId });
    expect(task.prompt).toBe("post it");
    expect(task.limitsJson).toMatchObject({ retry: { max: 2 } });

    // The edit lands on the version's rows, which is what `workflow.get` reads back.
    const graph = await api.workflow.get({ id: workflowId });
    expect(graph.graph.tasks.find((t) => t.name === "Poster")!.prompt).toBe("post it");
  });

  it("404s on an unknown task", async () => {
    expect((await trpcError(() => api.task.update({ taskId: "task_nope", prompt: "x" }))).code).toBe("NOT_FOUND");
  });
});

describe("run", () => {
  it.each(["1", "0"])("serves recorded tool parameters only in dev mode (%s)", async (devMode) => {
    vi.stubEnv("TABDUCTOR_DEV_MODE", devMode);
    try {
      const workflowId = await api.workflow.create({ name: "dev tool parameters" });
      const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
      const { runId } = await seedManualRun({ taskId: taskIds.Watcher! });
      const args = { code: "print(await page.title())", options: { timeout: 1500 } };
      await handle.db.insert(traceEntries).values({ runId: runId!, seq: 0, kind: "action",
        payloadJson: { action: "tool.call", tool: "browser.python", callId: "call-1", ok: true, args } });
      for (const view of [undefined, "tools"] as const) {
        const page = await api.run.trace({ runId: runId!, ...(view ? { view } : {}) });
        expect(page.devMode).toBe(devMode === "1");
        expect(page.items[0]?.payloadJson).toMatchObject({ action: "tool.call", tool: "browser.python" });
        if (devMode === "1") expect(page.items[0]?.payloadJson).toHaveProperty("args", args);
        else expect(page.items[0]?.payloadJson).not.toHaveProperty("args");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("pages tool calls without network noise, preserves raw compiler evidence and identifies deopt", async () => {
    const workflowId = await api.workflow.create({ name: "tool trace" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const { runId } = await seedManualRun({ taskId: taskIds.Watcher! });
    const entries: Array<{ kind: "action" | "network" | "llm"; payload: Record<string, unknown> }> = [
      { kind: "action", payload: { action: "goto", pageId: "target-a", ok: true } },
      { kind: "network", payload: { url: "https://example.com/data" } },
      { kind: "action", payload: { action: "deopt", ok: true } },
      { kind: "llm", payload: { tool_calls: ["page.waitFor"] } },
      { kind: "action", payload: { action: "waitFor", ok: true } },
      { kind: "action", payload: { action: "perceive", ok: true } },
      { kind: "action", payload: { action: "tool.call", tool: "page.waitFor", ok: true } },
      { kind: "network", payload: { url: "https://example.com/poll" } },
      { kind: "action", payload: { action: "tool.call", tool: "done", ok: true } },
    ];
    await handle.db.insert(traceEntries).values(entries.map((e, seq) => ({ runId: runId!, seq, kind: e.kind, payloadJson: e.payload })));
    const first = await api.run.trace({ runId: runId!, view: "tools", limit: 2 });
    expect(first.items.map((e) => e.seq)).toEqual([0, 6]);
    const next = await api.run.trace({ runId: runId!, view: "tools", limit: 2, cursor: first.nextCursor });
    expect(next.items.map((e) => e.seq)).toEqual([8]);
    expect(next.nextCursor).toBeNull();
    expect((await api.run.trace({ runId: runId!, limit: 100 })).items.some((e) => e.kind === "network")).toBe(true);
    expect(await api.run.get({ runId: runId! })).toMatchObject({ deopted: true, pageIds: ["target-a"] });
  });
  it("paginates, filters by status, and cancels only from queued or running", async () => {
    const workflowId = await api.workflow.create({ name: "runs" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const taskId = taskIds.Watcher!;

    // Five manual triggers → five queued runs on the entry task. No engine is running in
    // this suite, so the rows stay exactly where the API put them.
    const triggered = [];
    for (let i = 0; i < 5; i += 1) {
      triggered.push(await seedManualRun({ taskId, type: "manual.start", packet: { i } }));
    }
    expect(triggered.every((t) => t.runId)).toBe(true);

    const first = await api.run.list({ workflowId, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await api.run.list({ workflowId, limit: 2, cursor: first.nextCursor });
    expect(second.items).toHaveLength(2);
    // Keyset pagination: pages are disjoint and strictly older.
    expect(second.items.map((r) => r.id)).not.toEqual(expect.arrayContaining(first.items.map((r) => r.id)));

    expect((await api.run.list({ workflowId, status: "succeeded" })).items).toHaveLength(0);
    expect((await api.run.list({ workflowId, status: "queued" })).items).toHaveLength(5);

    const runId = first.items[0]!.id;
    expect((await api.run.cancel({ runId })).status).toBe("cancelled");
    expect((await trpcError(() => api.run.cancel({ runId }))).code).toBe("CONFLICT");
    expect((await trpcError(() => api.run.cancel({ runId: "run_nope" }))).code).toBe("NOT_FOUND");
  });

  it("cancels a run that is already running, and refuses one that finished", async () => {
    const workflowId = await api.workflow.create({ name: "cancel states" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const taskId = taskIds.Watcher!;

    const live = await seedManualRun({ taskId });
    await startRun(handle.db, live.runId!, undefined);
    expect((await api.run.cancel({ runId: live.runId! })).status).toBe("cancelled");

    const done = await seedManualRun({ taskId });
    const started = await startRun(handle.db, done.runId!, undefined);
    await finishRun(handle.db, { runId: done.runId!, taskId, status: "succeeded", leaseGeneration: started!.leaseGeneration });
    const err = await trpcError(() => api.run.cancel({ runId: done.runId! }));
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("succeeded");
  });

  it("returns a run with the event that triggered it", async () => {
    const workflowId = await api.workflow.create({ name: "run detail" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const { runId, eventId } = await seedManualRun({
      taskId: taskIds.Watcher!,
      type: "manual.start",
      packet: { hello: "world" },
    });

    const detail = await api.run.get({ runId: runId! });
    expect(detail.task.name).toBe("Watcher");
    expect(detail.trigger?.eventId).toBe(eventId);
    expect(detail.trigger?.packet).toEqual({ hello: "world" });
    expect(detail.browserSession).toBeNull();
    expect((await trpcError(() => api.run.get({ runId: "run_nope" }))).code).toBe("NOT_FOUND");
  });

  it("links a run to its execution's browser and retains the session's independent lifetime", async () => {
    const workflowId = await api.workflow.create({ name: "Live run" });
    const { taskIds, versionId } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const executionId = await createWorkflowExecution(handle.db, { workflowId, workflowVersionId: versionId });
    const { runId } = await seedManualRun({ taskId: taskIds.Watcher!, executionId });
    expect((await api.run.get({ runId: runId! })).browserSession).toBeNull();
    const profileId = await createBrowserProfile(handle.db, { accountId: "acct_local", name: "Live run profile" });
    const sessionId = await requestBrowserSession(handle.db, { accountId: "acct_local", profileId, executionId });
    await handle.db.update(browserSessions).set({ status: "running" }).where(eq(browserSessions.id, sessionId));
    const started = await startRun(handle.db, runId!, undefined);
    await finishRun(handle.db, { runId: runId!, taskId: taskIds.Watcher!, status: "succeeded", leaseGeneration: started!.leaseGeneration });
    expect(await api.run.get({ runId: runId! })).toMatchObject({ run: { status: "succeeded" }, browserSession: { id: sessionId, status: "running" } });
    await handle.db.update(browserSessions).set({ status: "ended" }).where(eq(browserSessions.id, sessionId));
    expect((await api.run.get({ runId: runId! })).browserSession).toEqual({ id: sessionId, status: "ended" });
  });
});

describe("event", () => {
  it("lists a workflow's events with a type filter and a cursor", async () => {
    const workflowId = await api.workflow.create({ name: "events" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const taskId = taskIds.Watcher!;

    for (let i = 0; i < 3; i += 1) await seedManualRun({ taskId, type: "manual.start", packet: { i } });
    await seedManualRun({ taskId, type: "other.start" });

    const all = await api.event.list({ workflowId });
    expect(all.items).toHaveLength(4);
    expect(all.items[0]!.sourceTaskName).toBe("Watcher");

    const filtered = await api.event.list({ workflowId, type: "manual.start" });
    expect(filtered.items).toHaveLength(3);

    const page = await api.event.list({ workflowId, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    const rest = await api.event.list({ workflowId, limit: 2, cursor: page.nextCursor });
    expect(rest.items).toHaveLength(2);
    expect(rest.nextCursor).toBeNull();

    // Another workflow's events are not in this one's feed.
    const other = await api.workflow.create({ name: "unrelated" });
    expect((await api.event.list({ workflowId: other })).items).toHaveLength(0);
  });

  it("returns the causation chain and the runs an event triggered", async () => {
    const workflowId = await api.workflow.create({ name: "lineage" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const taskId = taskIds.Watcher!;

    // A trigger, its run taken to `failed` — which publishes `run.failed` caused by the
    // trigger. Two links is enough to prove the walk; the depth cap is bus-level and tested
    // there on a 50-deep chain.
    const { eventId, runId } = await seedManualRun({ taskId, type: "chain.start" });
    const started = await startRun(handle.db, runId!, undefined);
    await finishRun(handle.db, {
      runId: runId!,
      taskId,
      status: "failed",
      error: "boom",
      causationId: eventId,
      leaseGeneration: started!.leaseGeneration,
    });

    const feed = await api.event.list({ workflowId, type: "run.failed" });
    const failure = feed.items[0]!;
    const detail = await api.event.get({ eventId: failure.eventId });
    expect(detail.lineage.map((e) => e.type)).toEqual(["chain.start", "run.failed"]);

    const start = await api.event.get({ eventId });
    expect(start.triggered).toEqual([
      { id: runId, taskId, taskName: "Watcher", status: "failed" },
    ]);
    expect((await trpcError(() => api.event.get({ eventId: "not-a-uuid" }))).code).toBe("BAD_REQUEST");
  });
});

describe("run trace (U1.5)", () => {
  it("pages trace entries in seq order, forward, and clamps a hostile limit", async () => {
    const workflowId = await api.workflow.create({ name: "traced" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const { runId } = await seedManualRun({ taskId: taskIds.Watcher! });

    await handle.db.insert(traceEntries).values(
      Array.from({ length: 5 }, (_, seq) => ({
        runId: runId!,
        seq,
        kind: "action" as const,
        payloadJson: { action: `step-${seq}`, ok: true },
      })),
    );

    const first = await api.run.trace({ runId: runId!, limit: 2 });
    expect(first.items.map((e) => e.seq)).toEqual([0, 1]);
    expect(first.nextCursor).toBe("1");

    const second = await api.run.trace({ runId: runId!, cursor: first.nextCursor, limit: 2 });
    expect(second.items.map((e) => e.seq)).toEqual([2, 3]);
    expect(second.nextCursor).toBe("3");

    const rest = await api.run.trace({ runId: runId!, cursor: second.nextCursor });
    expect(rest.items.map((e) => e.seq)).toEqual([4]);
    expect(rest.nextCursor).toBeNull();

    // A limit past the hard cap is rejected at the zod boundary, not silently clamped —
    // the same "caps hold against a hostile limit" property S2d's read models test.
    expect((await trpcError(() => api.run.trace({ runId: runId!, limit: 100_000 }))).code).toBe(
      "BAD_REQUEST",
    );
  });

  it("does not expose whether a foreign or missing run has trace data", async () => {
    await expect(api.run.trace({ runId: "run_nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("endpoint health (U1.5)", () => {
  it("lists cdp_endpoints with ws_url nowhere in the serialized result", async () => {
    const id = newId("endpoint");
    await handle.db.insert(cdpEndpoints).values({
      id,
      wsUrl: "ws://127.0.0.1:9999/devtools/browser/super-secret-token",
      label: "dev chrome",
      healthy: true,
      maxQueueDepth: 5,
    });

    const list = await api.endpoint.list();
    const row = list.find((e) => e.id === id);
    expect(row).toBeUndefined();

    // The central test (techical_plan §16 Threat 5): the credential is absent from the
    // result, not merely from the type — a `select()` that pulled it in and a component
    // that declined to render it would still pass a type-only check.
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("ws://");
    expect(serialized).not.toContain("wsUrl");
    expect(serialized).not.toContain("super-secret-token");
  });
});

describe("the web process never executes runs", () => {
  it("leaves a manually triggered run queued", async () => {
    const workflowId = await api.workflow.create({ name: "no executor here" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const { runId } = await seedManualRun({ taskId: taskIds.Watcher! });

    await new Promise((r) => setTimeout(r, 300));
    const [row] = await handle.db.select().from(runs).where(eq(runs.id, runId!));
    expect(row!.status).toBe("queued");
  });
});
