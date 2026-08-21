import { afterEach, expect, it } from "vitest";
import { newId } from "@tabductor/core";
import { compiledScripts } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  activateScript,
  getActiveScript,
  insertCandidateScript,
  invalidateScript,
} from "@tabductor/compiler";
import { seedWorkflow } from "@tabductor/engine";
import { eq } from "drizzle-orm";

/**
 * The shelf. Versions, the activation swap, and the invariant the database itself holds.
 *
 * The last of those is the one worth having: `compiled_scripts_active_task_key` is a partial
 * unique index, so "at most one active script per task" is a fact Postgres enforces rather
 * than something S6c's promotion logic has to get right under concurrent writes. The direct
 * two-actives insert below is what proves it — without it, `activateScript` passing only says
 * the happy path works.
 */

let handle: MigratedTestDb | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function twoTasks(): Promise<{ a: string; b: string }> {
  const wf = await seedWorkflow(handle!.db, { tasks: { A: {}, B: {} } });
  return { a: wf.taskIds.A!, b: wf.taskIds.B! };
}

it("versions start at 1 and increment per task, independently", async () => {
  handle = await createMigratedTestDb();
  const { a, b } = await twoTasks();

  const a1 = await insertCandidateScript(handle.db, { taskId: a, source: "// a1" });
  const a2 = await insertCandidateScript(handle.db, { taskId: a, source: "// a2" });
  const b1 = await insertCandidateScript(handle.db, { taskId: b, source: "// b1" });

  expect([a1.version, a2.version, b1.version]).toEqual([1, 2, 1]);
  expect(a1.status).toBe("candidate");
  expect(a1.fromRuns).toEqual([]);
});

it("carries provenance — the runs a script was compiled from", async () => {
  handle = await createMigratedTestDb();
  const { a } = await twoTasks();
  const row = await insertCandidateScript(handle.db, {
    taskId: a,
    source: "// x",
    fromRuns: ["run_181", "run_187"],
    guardsMeta: { checks: 3 },
  });
  expect(row.fromRuns).toEqual(["run_181", "run_187"]);
  expect(row.guardsMeta).toEqual({ checks: 3 });
});

it("getActiveScript is null until something is activated", async () => {
  handle = await createMigratedTestDb();
  const { a } = await twoTasks();
  await insertCandidateScript(handle.db, { taskId: a, source: "// candidate" });
  expect(await getActiveScript(handle.db, a)).toBeNull();
});

it("activation swaps atomically: the prior active is invalidated in the same transaction", async () => {
  handle = await createMigratedTestDb();
  const { a } = await twoTasks();
  const v1 = await insertCandidateScript(handle.db, { taskId: a, source: "// v1" });
  const v2 = await insertCandidateScript(handle.db, { taskId: a, source: "// v2" });

  await activateScript(handle.db, v1.id);
  expect((await getActiveScript(handle.db, a))?.id).toBe(v1.id);

  await activateScript(handle.db, v2.id);

  // Both rows read in one query, so the assertion is about the pair, not two moments.
  const rows = await handle.db.select().from(compiledScripts).where(eq(compiledScripts.taskId, a));
  const byId = new Map(rows.map((r) => [r.id, r.status]));
  expect(byId.get(v1.id)).toBe("invalidated");
  expect(byId.get(v2.id)).toBe("active");
});

it("the database refuses a second active row for a task, not just the registry", async () => {
  handle = await createMigratedTestDb();
  const { a } = await twoTasks();
  const v1 = await insertCandidateScript(handle.db, { taskId: a, source: "// v1" });
  await activateScript(handle.db, v1.id);

  // Bypasses `activateScript` entirely: this is the partial unique index or nothing.
  const err = await handle.db
    .insert(compiledScripts)
    .values({ id: newId("script"), taskId: a, version: 99, source: "// sneaky", status: "active" })
    .catch((e: unknown) => e);

  const cause = err instanceof Error ? err.cause : undefined;
  const message = cause instanceof Error ? cause.message : String(err);
  expect(message).toContain("compiled_scripts_active_task_key");
});

it("invalidateScript retires a script without touching its siblings", async () => {
  handle = await createMigratedTestDb();
  const { a } = await twoTasks();
  const v1 = await insertCandidateScript(handle.db, { taskId: a, source: "// v1" });
  const v2 = await insertCandidateScript(handle.db, { taskId: a, source: "// v2" });
  await activateScript(handle.db, v2.id);

  await invalidateScript(handle.db, v2.id);
  expect(await getActiveScript(handle.db, a)).toBeNull();

  const [stillCandidate] = await handle.db
    .select()
    .from(compiledScripts)
    .where(eq(compiledScripts.id, v1.id));
  expect(stillCandidate?.status).toBe("candidate");
});

it("the status domain is closed by a check constraint", async () => {
  handle = await createMigratedTestDb();
  const { a } = await twoTasks();
  const err = await handle.db
    .insert(compiledScripts)
    .values({ id: newId("script"), taskId: a, version: 1, source: "// x", status: "retired" as never })
    .catch((e: unknown) => e);
  const cause = err instanceof Error ? err.cause : undefined;
  expect(cause instanceof Error ? cause.message : String(err)).toContain("compiled_scripts_status_check");
});
