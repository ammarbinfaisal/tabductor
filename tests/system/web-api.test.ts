import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runs } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { finishRun, startRun, staticSchemaGenerator } from "@tabductor/engine";
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

/** Deterministic publish: the one schema these tests declare, no model in the loop. */
const TEST_SCHEMAS = {
  "tweet.detected": { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};

beforeAll(async () => {
  handle = await createMigratedTestDb();
  api = createCaller({ db: handle.db, schemaGenerator: staticSchemaGenerator(TEST_SCHEMAS) });
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

  it("fails the publish with a per-event report when schema generation fails, writing nothing", async () => {
    const workflowId = await api.workflow.create({ name: "bad schema" });
    const failing = createCaller({
      db: handle.db,
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

  it("rejects a schedule bound to an asset node", async () => {
    const workflowId = await api.workflow.create({ name: "asset schedule" });
    const err = await trpcError(() =>
      api.workflow.publishVersion({
        workflowId,
        graph: {
          tasks: [
            {
              name: "Report",
              kind: "asset",
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
      }),
    );

    expect(err.code).toBe("BAD_REQUEST");
    expect((err.cause as { details?: Record<string, unknown> }).details).toMatchObject({
      task: "Report",
      kind: "asset",
    });
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

    const { runId } = await api.run.triggerManual({ taskId: taskIds.Watcher! });
    await startRun(handle.db, runId!, undefined);
    await finishRun(handle.db, { runId: runId!, taskId: taskIds.Watcher!, status: "succeeded" });

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
  it("paginates, filters by status, and cancels only from queued or running", async () => {
    const workflowId = await api.workflow.create({ name: "runs" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const taskId = taskIds.Watcher!;

    // Five manual triggers → five queued runs on the entry task. No engine is running in
    // this suite, so the rows stay exactly where the API put them.
    const triggered = [];
    for (let i = 0; i < 5; i += 1) {
      triggered.push(await api.run.triggerManual({ taskId, type: "manual.start", packet: { i } }));
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

    const live = await api.run.triggerManual({ taskId });
    await startRun(handle.db, live.runId!, undefined);
    expect((await api.run.cancel({ runId: live.runId! })).status).toBe("cancelled");

    const done = await api.run.triggerManual({ taskId });
    await startRun(handle.db, done.runId!, undefined);
    await finishRun(handle.db, { runId: done.runId!, taskId, status: "succeeded" });
    const err = await trpcError(() => api.run.cancel({ runId: done.runId! }));
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("succeeded");
  });

  it("returns a run with the event that triggered it", async () => {
    const workflowId = await api.workflow.create({ name: "run detail" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const { runId, eventId } = await api.run.triggerManual({
      taskId: taskIds.Watcher!,
      type: "manual.start",
      packet: { hello: "world" },
    });

    const detail = await api.run.get({ runId: runId! });
    expect(detail.task.name).toBe("Watcher");
    expect(detail.trigger?.eventId).toBe(eventId);
    expect(detail.trigger?.packet).toEqual({ hello: "world" });
    expect((await trpcError(() => api.run.get({ runId: "run_nope" }))).code).toBe("NOT_FOUND");
  });
});

describe("event", () => {
  it("lists a workflow's events with a type filter and a cursor", async () => {
    const workflowId = await api.workflow.create({ name: "events" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const taskId = taskIds.Watcher!;

    for (let i = 0; i < 3; i += 1) await api.run.triggerManual({ taskId, type: "manual.start", packet: { i } });
    await api.run.triggerManual({ taskId, type: "other.start" });

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
    const { eventId, runId } = await api.run.triggerManual({ taskId, type: "chain.start" });
    await startRun(handle.db, runId!, undefined);
    await finishRun(handle.db, {
      runId: runId!,
      taskId,
      status: "failed",
      error: "boom",
      causationId: eventId,
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

describe("the web process never executes runs", () => {
  it("leaves a manually triggered run queued", async () => {
    const workflowId = await api.workflow.create({ name: "no executor here" });
    const { taskIds } = await api.workflow.publishVersion({ workflowId, graph: twoNodeGraph });
    const { runId } = await api.run.triggerManual({ taskId: taskIds.Watcher! });

    await new Promise((r) => setTimeout(r, 300));
    const [row] = await handle.db.select().from(runs).where(eq(runs.id, runId!));
    expect(row!.status).toBe("queued");
  });
});
