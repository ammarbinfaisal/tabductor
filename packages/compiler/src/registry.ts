import { newId } from "@tabductor/core";
import { compiledScripts, type CompiledScriptRow, type Db } from "@tabductor/db";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * The shelf: version rows for a task's compiled scripts.
 *
 * A handful of functions over `db`, not a `ScriptRegistry` class — matching S6b's own "no
 * CompilerService" rule and this repo's general aversion to abstraction with one caller.
 *
 * Nothing here decides *when* a script is activated or invalidated. These are the primitives
 * S6b's `compileTask` and S6c's promotion/demotion call; the policy is theirs.
 */

export async function insertCandidateScript(
  db: Db,
  input: { taskId: string; source: string; guardsMeta?: unknown; fromRuns?: string[] },
): Promise<CompiledScriptRow> {
  // Prior max + 1, computed in SQL so two concurrent inserts collide on the
  // `(task_id, version)` unique index rather than silently reusing a version.
  const [prior] = await db
    .select({ version: compiledScripts.version })
    .from(compiledScripts)
    .where(eq(compiledScripts.taskId, input.taskId))
    .orderBy(desc(compiledScripts.version))
    .limit(1);

  const [row] = await db
    .insert(compiledScripts)
    .values({
      id: newId("script"),
      taskId: input.taskId,
      version: (prior?.version ?? 0) + 1,
      source: input.source,
      guardsMeta: (input.guardsMeta ?? {}) as Record<string, unknown>,
      fromRuns: input.fromRuns ?? [],
      status: "candidate",
    })
    .returning();
  return row!;
}

/** S6c's `CompiledExecutor` loader. `null` rather than a throw: a task with no active script
 * is the normal state for every task that has never been compiled. */
export async function getActiveScript(db: Db, taskId: string): Promise<CompiledScriptRow | null> {
  const [row] = await db
    .select()
    .from(compiledScripts)
    .where(and(eq(compiledScripts.taskId, taskId), eq(compiledScripts.status, "active")));
  return row ?? null;
}

/**
 * Promotion: this row becomes the task's active script, and whatever held that place is
 * invalidated. One transaction, leaning on `compiled_scripts_active_task_key` — the partial
 * unique index is what makes the swap safe under a concurrent activation rather than merely
 * usually-correct, so this does not hand-roll a race check on top of it.
 */
export async function activateScript(db: Db, scriptId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const [row] = await trx.select().from(compiledScripts).where(eq(compiledScripts.id, scriptId));
    if (!row) throw new Error(`no compiled script ${scriptId}`);

    await trx
      .update(compiledScripts)
      .set({ status: "invalidated" })
      .where(
        and(
          eq(compiledScripts.taskId, row.taskId),
          eq(compiledScripts.status, "active"),
          sql`${compiledScripts.id} <> ${scriptId}`,
        ),
      );
    await trx.update(compiledScripts).set({ status: "active" }).where(eq(compiledScripts.id, scriptId));
  });
}

/** Demotion, and the recompilation path's way of retiring a superseded version. */
export async function invalidateScript(db: Db, scriptId: string): Promise<void> {
  await db.update(compiledScripts).set({ status: "invalidated" }).where(eq(compiledScripts.id, scriptId));
}
