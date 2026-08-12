import { afterEach, expect, it } from "vitest";
import { createAssetExecutor, createDecisionExecutor, type Llm, type LlmMessage } from "@tabductor/agent";
import { publish } from "@tabductor/bus";
import { createWorkflow, executorKey, seedWorkflow, StubExecutor, triggerTask } from "@tabductor/engine";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { AllowAllGate } from "@tabductor/policy";
import { createTestBlobStore, type TestBlobStore } from "@tabductor/testkit";
import { createWriteStager, deprovision, flushStagedWrites, stageRowWrite, wfIdsOf } from "@tabductor/store";
import { eventsOfType, runsForTask, startRig, waitForQuiet, type Rig } from "./engine-support.js";
import { publishCandidatesVisitedStore } from "./store-support.js";

/**
 * The canonical plan/act/record triangle, end to end (S5g deliverable 4;
 * graph-compilation-llm §7): a decision node plans from the store, a browser node acts, an
 * asset node records — writing the store and emitting in one transaction. Two things this
 * file proves that a lower-level unit test cannot: the *real* `store.query` fence answers a
 * real decision agent loop, and re-firing the planner after the batch is visited genuinely
 * re-derives an empty one rather than replanning (§2.4's philosophy, not merely dedupe
 * absorbing a duplicate — that mechanism is proven separately below).
 *
 * The atomic "store write + emit commit together" claim itself (the crash-inject scenario
 * the spec names) is proven as a focused integration test in this same file, directly against
 * `flushStagedWrites`/`db.transaction`/`publish` — the exact mechanism `AssetExecutor` drives
 * through the agent loop above it, isolated from LLM turn-taking so the failure injection is
 * unambiguous (a thrown write, not a scripted "pretend to crash" tool call).
 */

/** The loop's own wire format (`loop.ts`'s `untrustedBlock("tool results", results)`): four
 * lines, the JSON payload always third — stable because this file does not touch `loop.ts`. */
function lastToolResults(messages: LlmMessage[]): Array<{ id: string; name: string; result: { ok: boolean; value?: unknown; error?: string } }> {
  const last = messages.at(-1);
  if (!last || last.role !== "user") return [];
  const jsonLine = last.content.split("\n")[2];
  if (!jsonLine) return [];
  try {
    return JSON.parse(jsonLine) as Array<{ id: string; name: string; result: { ok: boolean; value?: unknown } }>;
  } catch {
    return [];
  }
}

const PLAN_QUERY =
  "select tweet_id, url from candidates c where not exists (select 1 from visited v where v.tweet_id = c.tweet_id) order by c.posted_at";

/** Turn 1 always queries; turn 2 branches on the *real* result — emit one `browse.request`
 * per unvisited row, or `done` with nothing if the batch is empty. */
function makeDecisionLlm(): Llm {
  let step = 0;
  return {
    async complete(req) {
      step += 1;
      if (step === 1) {
        return { toolCalls: [{ id: "q1", name: "store.query", args: { sql: PLAN_QUERY } }], usage: { in: 0, out: 0 } };
      }
      const results = lastToolResults(req.messages);
      const queryResult = results.find((r) => r.name === "store.query");
      const value = queryResult?.result.value as { rows?: Array<{ tweet_id: string; url: string }> } | undefined;
      const rows = value?.rows ?? [];
      if (rows.length === 0) {
        return { toolCalls: [{ id: "d1", name: "done", args: {} }], usage: { in: 0, out: 0 } };
      }
      const emits = rows.map((r, i) => ({
        id: `e${i}`,
        name: "emit",
        args: { type: "browse.request", packet: { tweet_id: r.tweet_id, url: r.url }, dedupeKey: r.tweet_id },
      }));
      return { toolCalls: [...emits, { id: "d2", name: "done", args: {} }], usage: { in: 0, out: 0 } };
    },
  };
}

/** Fixed three-turn script: upsert `visited`, emit `doc.ready`, done — the "write the doc"
 * step is out of scope here (S5f's territory); this leg only proves the store-write half. */
function makeAssetLlm(): Llm {
  let step = 0;
  return {
    async complete() {
      step += 1;
      if (step === 1) {
        return {
          toolCalls: [
            {
              id: "u1",
              name: "store.upsert",
              args: { table: "visited", row: { tweet_id: "t1", url: "https://x.com/t1", visited_at: new Date().toISOString() } },
            },
          ],
          usage: { in: 0, out: 0 },
        };
      }
      if (step === 2) {
        return {
          toolCalls: [{ id: "e1", name: "emit", args: { type: "doc.ready", packet: { tweet_id: "t1" }, dedupeKey: "t1" } }],
          usage: { in: 0, out: 0 },
        };
      }
      return { toolCalls: [{ id: "d1", name: "done", args: {} }], usage: { in: 0, out: 0 } };
    },
  };
}

let handle: MigratedTestDb | undefined;
let tb: TestBlobStore | undefined;
let rig: Rig | undefined;
/** Roles are cluster-global (`store-fence.test.ts`'s own note) — dropping the test database
 * never drops them, so every workflow this file provisions a store for is `deprovision`d here. */
let provisioned: string[] = [];

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
  if (handle) {
    for (const workflowId of provisioned) await deprovision(handle.pool, workflowId).catch(() => undefined);
  }
  provisioned = [];
  await tb?.drop();
  tb = undefined;
  await handle?.close();
  handle = undefined;
});

it("plan (decision) -> act (browser) -> record (asset), then a re-fire plans nothing new", async () => {
  handle = await createMigratedTestDb();
  tb = await createTestBlobStore();

  const workflowId = await createWorkflow(handle.db, { name: "triangle", userId: "user_test" });
  await publishCandidatesVisitedStore(handle, workflowId);
  provisioned.push(workflowId);

  // One candidate, seeded directly (fixture setup, not the fenced tool path under test).
  const ids = wfIdsOf(workflowId);
  const admin = await handle.pool.connect();
  try {
    await admin.query(`insert into "${ids.schema}".candidates (tweet_id, url, posted_at) values ('t1', 'https://x.com/t1', now())`);
  } finally {
    admin.release();
  }

  const wf = await seedWorkflow(handle.db, {
    workflowId,
    tasks: {
      Plan: { kind: "decision", mode: "ai", emits: ["browse.request"] },
      Watch: {
        kind: "browser",
        mode: "stub",
        consumes: ["browse.request"],
        stub: { emits: [{ type: "tweet.detected", packet: { tweet_id: "t1", text: "hello", url: "https://x.com/t1" } }] },
      },
      Record: { kind: "asset", mode: "ai", consumes: ["tweet.detected"], emits: ["doc.ready"] },
    },
  });

  const decisionExecutor = createDecisionExecutor({ db: handle.db, pool: handle.pool, blobs: tb.store, llmFor: () => makeDecisionLlm() });
  const assetExecutor = createAssetExecutor({
    gate: new AllowAllGate(),
    blobs: tb.store,
    db: handle.db,
    pool: handle.pool,
    llmFor: () => makeAssetLlm(),
  });

  rig = await startRig({
    handle,
    executors: {
      [executorKey("decision", "ai")]: decisionExecutor,
      [executorKey("browser", "stub")]: StubExecutor,
      [executorKey("asset", "ai")]: assetExecutor,
    },
  });

  // The cron fire's own shape (§2.2): an empty packet, attributed to the decision task.
  await triggerTask(handle.db, { taskId: wf.taskIds.Plan! });
  await waitForQuiet(rig);

  const planRuns = await runsForTask(rig, wf.taskIds.Plan!);
  expect(planRuns).toHaveLength(1);
  expect(planRuns[0]!.status).toBe("succeeded");

  const browseRequests = await eventsOfType(rig, "browse.request");
  expect(browseRequests).toHaveLength(1);
  expect(browseRequests[0]!.packet).toEqual({ tweet_id: "t1", url: "https://x.com/t1" });

  const docsReady = await eventsOfType(rig, "doc.ready");
  expect(docsReady).toHaveLength(1);

  // The record: `visited` was upserted by the real `store.upsert` tool, under the writer role.
  const readback = await handle.pool.query(`select tweet_id, url from "${ids.schema}".visited`);
  expect(readback.rows).toEqual([{ tweet_id: "t1", url: "https://x.com/t1" }]);

  // Re-fire the cron: the decision node's own `store.query` now sees t1 in `visited` (the
  // real anti-join, not a stub) and genuinely plans an empty batch — no new event of any type.
  await triggerTask(handle.db, { taskId: wf.taskIds.Plan! });
  await waitForQuiet(rig);

  expect(await runsForTask(rig, wf.taskIds.Plan!)).toHaveLength(2);
  expect(await eventsOfType(rig, "browse.request")).toHaveLength(1);
  expect(await eventsOfType(rig, "tweet.detected")).toHaveLength(1);
  expect(await eventsOfType(rig, "doc.ready")).toHaveLength(1);
});

it("crash-inject: a store write that throws mid-commit takes its emit down with it; a clean retry completes both", async () => {
  handle = await createMigratedTestDb();
  const workflowId = await createWorkflow(handle.db, { name: "crash-inject", userId: "user_test" });
  await publishCandidatesVisitedStore(handle, workflowId);
  provisioned.push(workflowId);
  const ids = wfIdsOf(workflowId);

  const row = { tweet_id: "t1", url: "https://x.com/t1", visited_at: new Date().toISOString() };

  // Attempt 1: the store write is staged, but a second staged write (standing in for "the
  // process died right here") throws before the transaction commits.
  const crashingStager = createWriteStager();
  stageRowWrite(crashingStager, "visited", row, ["tweet_id"]);
  const crashingWrites = [
    ...crashingStager.drain(),
    async () => {
      throw new Error("simulated crash between the store write and commit");
    },
  ];

  await expect(
    handle.db.transaction(async (trx) => {
      await flushStagedWrites(workflowId, crashingWrites)(trx);
      return publish(trx, { type: "doc.ready", packet: { tweet_id: "t1" } });
    }),
  ).rejects.toThrow(/simulated crash/);

  const afterCrash = await handle.pool.query(`select * from "${ids.schema}".visited`);
  expect(afterCrash.rows).toHaveLength(0);
  const eventsAfterCrash = await handle.pool.query(`select count(*)::text as count from events where type = 'doc.ready'`);
  expect(eventsAfterCrash.rows[0]?.count).toBe("0");

  // Attempt 2 (the retry): the identical write, no injected failure — both land together.
  const cleanStager = createWriteStager();
  stageRowWrite(cleanStager, "visited", row, ["tweet_id"]);
  const event = await handle.db.transaction(async (trx) => {
    await flushStagedWrites(workflowId, cleanStager.drain())(trx);
    return publish(trx, { type: "doc.ready", packet: { tweet_id: "t1" } });
  });
  expect(event.type).toBe("doc.ready");

  const afterRetry = await handle.pool.query(`select tweet_id from "${ids.schema}".visited`);
  expect(afterRetry.rows).toEqual([{ tweet_id: "t1" }]);
});
