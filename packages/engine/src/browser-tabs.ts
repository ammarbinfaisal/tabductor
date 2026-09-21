import { AppError } from "@tabductor/core";
import { browserTabLeases, browserSessions, runs, type Db } from "@tabductor/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertRunLease } from "./run-lease.js";

export type BrowserTabLease = { sessionId: string; tabKey: string; runId: string; runGeneration: number; taskId: string };

/** Tasks may explicitly share a tab; repeated packets default to their task's tab. */
export function browserTabKey(task: { id: string; limitsJson: unknown }): string {
  const browser = (task.limitsJson as { browser?: { tab_key?: unknown } } | null)?.browser;
  const key = browser?.tab_key;
  if (key === undefined) return task.id;
  if (typeof key !== "string" || !key.trim() || key.length > 160) {
    throw new AppError("browser_tab_key_invalid", "browser.tab_key must be a nonempty string of at most 160 characters");
  }
  return key;
}

export async function claimBrowserTab(db: Db, lease: BrowserTabLease): Promise<boolean> {
  return db.transaction(async (trx) => {
    await assertRunLease(trx, lease.runId, lease.runGeneration);
    const [session] = await trx.select({ id: browserSessions.id, inputOwner: browserSessions.inputOwner }).from(browserSessions).where(and(
      eq(browserSessions.id, lease.sessionId), inArray(browserSessions.status, ["ready", "running"]),
      sql`${browserSessions.executionId} = (select execution_id from ${runs} where id = ${lease.runId})`,
    )).for("share");
    if (!session) throw new AppError("browser.disconnected", "browser session ended");
    if (session.inputOwner !== "ai") return false;
    await trx.insert(browserTabLeases).values({ sessionId: lease.sessionId, tabKey: lease.tabKey }).onConflictDoNothing();
    const [claimed] = await trx.update(browserTabLeases).set({ runId: lease.runId, runGeneration: lease.runGeneration, taskId: lease.taskId })
      .where(and(eq(browserTabLeases.sessionId, lease.sessionId), eq(browserTabLeases.tabKey, lease.tabKey), sql`(
        ${browserTabLeases.runId} is null or not exists (
          select 1 from ${runs} r where r.id = ${browserTabLeases.runId}
            and r.lease_generation = ${browserTabLeases.runGeneration} and r.status in ('running','awaiting_approval')
        )
      )`)).returning({ key: browserTabLeases.tabKey });
    return !!claimed;
  });
}

export async function assertBrowserTabLease(trx: Db, lease: BrowserTabLease): Promise<void> {
  const [owned] = await trx.select({ key: browserTabLeases.tabKey }).from(browserTabLeases).where(and(
    eq(browserTabLeases.sessionId, lease.sessionId), eq(browserTabLeases.tabKey, lease.tabKey),
    eq(browserTabLeases.runId, lease.runId), eq(browserTabLeases.runGeneration, lease.runGeneration),
  )).for("share");
  if (!owned) throw new AppError("browser_tab_lease_lost", "browser tab was released or reassigned");
}

export async function releaseBrowserTab(db: Db, lease: BrowserTabLease): Promise<void> {
  await db.update(browserTabLeases).set({ runId: null, runGeneration: null }).where(and(
    eq(browserTabLeases.sessionId, lease.sessionId), eq(browserTabLeases.tabKey, lease.tabKey),
    eq(browserTabLeases.runId, lease.runId), eq(browserTabLeases.runGeneration, lease.runGeneration),
  ));
}
