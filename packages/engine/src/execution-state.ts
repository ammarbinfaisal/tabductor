import { newId } from "@tabductor/core";
import { runs, tasks, workflowExecutions, type Db } from "@tabductor/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Durable quiescence: a traversal is live while any run (including a retry or pause) or
 * outbox delivery remains unsettled. Producers commit roots atomically and finish runs
 * atomically with retry creation, so neither operation exposes a false quiet interval.
 * Failed attempts superseded by later attempts do not make a recovered execution fail.
 */
export async function settleWorkflowExecutions(db: Db): Promise<string[]> {
  return db.transaction(async (trx) => {
    // Lock each quiet execution before either queuing its finalizer or ending it.
    // SKIP LOCKED lets concurrent engine sweeps cooperate without duplicate result runs.
    const quiet = await trx.execute<{ id: string; workflow_version_id: string; outcome: "succeeded" | "failed" | "cancelled" }>(sql`
      select x.id, x.workflow_version_id, case
      when exists (
        select 1 from runs r where r.execution_id = x.id and r.status = 'cancelled'
      ) then 'cancelled'
      when exists (
        select 1 from runs r where r.execution_id = x.id and r.status in ('failed', 'timed_out')
          and not exists (
            select 1 from runs successor where successor.execution_id = x.id
              and successor.task_id = r.task_id
              and successor.trigger_event_id is not distinct from r.trigger_event_id
              and successor.attempt > r.attempt
          )
      ) or exists (
        select 1 from events e left join outbox o on o.event_id = e.event_id
        where e.execution_id = x.id
          and (o.status = 'dead_letter' or e.type in ('system.loop_budget_exceeded', 'system.run_budget_exceeded'))
      ) or exists (
        select 1 from workflow_records record where record.execution_id = x.id
          and record.status in ('extracted', 'prepared', 'pending', 'failed', 'rejected')
      ) then 'failed'
      else 'succeeded'
    end as outcome
      from workflow_executions x
    where x.status = 'running'
      and exists (select 1 from events e where e.execution_id = x.id)
      and not exists (
        select 1 from runs r where r.execution_id = x.id
          and r.status in ('queued', 'running', 'awaiting_approval', 'awaiting_human')
      )
      and not exists (
        select 1 from events e join outbox o on o.event_id = e.event_id
        where e.execution_id = x.id and o.status = 'pending'
      )
      for update of x skip locked
    `);
    const settled: string[] = [];
    for (const execution of quiet.rows) {
      const [task] = await trx.select().from(tasks).where(and(
        eq(tasks.workflowVersionId, execution.workflow_version_id), eq(tasks.kind, "result"),
      ));
      const [prior] = task ? await trx.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.executionId, execution.id), eq(runs.taskId, task.id))).limit(1) : [];
      if (task && !prior && execution.outcome !== "cancelled") {
        // Finalization has one reserved run outside the traversal budget, so a budget
        // failure can still produce a useful result. No event is emitted or routed.
        await trx.insert(runs).values({ id: newId("run"), executionId: execution.id,
          taskId: task.id, workflowVersionId: execution.workflow_version_id,
          modeUsed: task.mode, status: "queued" });
        continue;
      }
      await trx.update(workflowExecutions).set({ status: execution.outcome, endedAt: sql`now()` })
        .where(eq(workflowExecutions.id, execution.id));
      settled.push(execution.id);
    }
    return settled;
  });
}
