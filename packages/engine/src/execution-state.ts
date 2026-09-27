import { workflowExecutions, type Db } from "@tabductor/db";
import { eq, sql } from "drizzle-orm";

/** Runtime completion queues finalization without creating a result task or another run. */
export async function settleWorkflowExecutions(db: Db): Promise<string[]> {
  return db.transaction(async trx => {
    const quiet = await trx.execute<{ id: string; outcome: "succeeded" | "failed" | "cancelled" }>(sql`
      select x.id, case
        when exists (select 1 from runs r where r.execution_id=x.id and r.status='cancelled') then 'cancelled'
        when (select r.status from runs r where r.execution_id=x.id order by r.attempt desc, r.created_at desc limit 1) <> 'succeeded'
          or exists (select 1 from workflow_records r where r.execution_id=x.id and r.status in ('extracted','prepared','pending','failed','rejected')) then 'failed'
        else 'succeeded' end as outcome
      from workflow_executions x where x.status='running' and x.runtime_status is null
        and exists (select 1 from runs r where r.execution_id=x.id)
        and not exists (select 1 from runs r where r.execution_id=x.id and r.status in ('queued','running','awaiting_approval','awaiting_human'))
      for update of x skip locked`);
    for (const item of quiet.rows) await trx.update(workflowExecutions).set({ runtimeStatus: item.outcome,
      ...(item.outcome === "cancelled" ? { status: "cancelled" as const, finalizationStatus: "skipped", endedAt: new Date() } : {}) })
      .where(eq(workflowExecutions.id, item.id));
    return quiet.rows.map(item => item.id);
  });
}
