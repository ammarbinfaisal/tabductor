import { afterEach, expect, it } from "vitest";
import { schedules, tasks, workflowVersions, workflows } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflow, publishVersion, staticSchemaGenerator, type Graph } from "@tabductor/engine";
import { eq } from "drizzle-orm";

/**
 * A publish *replaces* a workflow's schedules rather than adding to them.
 *
 * The bug this guards was silent and compounding. Every version gets fresh task rows, so a
 * republish inserted a *new* schedule row and left the superseded one `enabled`; nothing
 * else ever retired it. The scheduler selects on `enabled` alone and routes each fire
 * against the latest version, so N publishes of one scheduled task produced N fires per
 * tick, every one landing on the single current task — and the genuine schedule was the one
 * that got skipped, its own overlap policy locked out by the duplicates it was competing
 * with. Seven publishes, six runs a tick, one authored.
 *
 * Asserting the *count* is the point: a test that only checked "a schedule exists for the
 * current task" passed throughout the entire bug.
 */

const noGenerator = staticSchemaGenerator({});

const scheduledGraph = (cron: string): Graph => ({
  tasks: [
    {
      name: "T",
      kind: "browser",
      mode: "ai",
      prompt: null,
      limits: {},
      emits: [],
      consumes: [],
      schedule: { cron, tz: "UTC", missedPolicy: "skip", overlapPolicy: "skip", maxQueueDepth: 1, enabled: true },
      position: null,
    },
  ],
  events: [],
});

let handle: MigratedTestDb | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

/** Every schedule row reachable from any version of this workflow — the set the scheduler
 * would actually see, which is precisely what the old code let grow. */
async function liveSchedules(db: MigratedTestDb["db"], workflowId: string) {
  return db
    .select({ id: schedules.id, cron: schedules.cron, versionId: tasks.workflowVersionId })
    .from(schedules)
    .innerJoin(tasks, eq(tasks.id, schedules.taskId))
    .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
    .where(eq(workflowVersions.workflowId, workflowId));
}

it("republishing replaces the workflow's schedules instead of accumulating them", async () => {
  handle = await createMigratedTestDb();
  const db = handle.db;
  const workflowId = await createWorkflow(db, { name: "schedule-replace", userId: "user_test" });

  await publishVersion(db, { workflowId, graph: scheduledGraph("*/5 * * * *") }, { schemaGenerator: noGenerator });
  expect(await liveSchedules(db, workflowId)).toHaveLength(1);

  // Three more publishes — the shape that produced six-fires-a-tick in the wild.
  for (const cron of ["*/6 * * * *", "*/7 * * * *", "*/8 * * * *"]) {
    await publishVersion(db, { workflowId, graph: scheduledGraph(cron) }, { schemaGenerator: noGenerator });
  }

  const live = await liveSchedules(db, workflowId);
  expect(live).toHaveLength(1);

  // The survivor is the newly published one, not a leftover that happens to be alone.
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
  expect(live[0]?.versionId).toBe(workflow?.currentVersionId);
  expect(live[0]?.cron).toBe("*/8 * * * *");
});

it("publishing a graph with no schedule clears the previous version's", async () => {
  handle = await createMigratedTestDb();
  const db = handle.db;
  const workflowId = await createWorkflow(db, { name: "schedule-clear", userId: "user_test" });

  await publishVersion(db, { workflowId, graph: scheduledGraph("*/5 * * * *") }, { schemaGenerator: noGenerator });
  expect(await liveSchedules(db, workflowId)).toHaveLength(1);

  // Unscheduling a task is an edit like any other: the old row must not outlive the version
  // that declared it, or the task keeps firing on a cadence the graph no longer mentions.
  const unscheduled = scheduledGraph("*/5 * * * *");
  unscheduled.tasks[0]!.schedule = null;
  await publishVersion(db, { workflowId, graph: unscheduled }, { schemaGenerator: noGenerator });

  expect(await liveSchedules(db, workflowId)).toHaveLength(0);
});

it("a republish leaves another workflow's schedules untouched", async () => {
  handle = await createMigratedTestDb();
  const db = handle.db;
  const mine = await createWorkflow(db, { name: "schedule-mine", userId: "user_test" });
  const theirs = await createWorkflow(db, { name: "schedule-theirs", userId: "user_test" });

  await publishVersion(db, { workflowId: theirs, graph: scheduledGraph("*/9 * * * *") }, { schemaGenerator: noGenerator });
  await publishVersion(db, { workflowId: mine, graph: scheduledGraph("*/5 * * * *") }, { schemaGenerator: noGenerator });
  await publishVersion(db, { workflowId: mine, graph: scheduledGraph("*/6 * * * *") }, { schemaGenerator: noGenerator });

  expect(await liveSchedules(db, mine)).toHaveLength(1);
  const others = await liveSchedules(db, theirs);
  expect(others).toHaveLength(1);
  expect(others[0]?.cron).toBe("*/9 * * * *");
});
