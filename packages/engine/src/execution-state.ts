import { type Db } from "@tabductor/db";
import { sql } from "drizzle-orm";

/**
 * Durable quiescence: a traversal is live while any run (including a retry or pause) or
 * outbox delivery remains unsettled. Producers commit roots atomically and finish runs
 * atomically with retry creation, so neither operation exposes a false quiet interval.
 * Failed attempts superseded by later attempts do not make a recovered execution fail.
 */
export async function settleWorkflowExecutions(db: Db): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    update workflow_executions x
    set ended_at = now(), status = case
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
          and (o.status = 'dead_letter' or e.type = 'system.loop_budget_exceeded')
      ) then 'failed'
      else 'succeeded'
    end
    where x.status = 'running'
      and exists (select 1 from events e where e.execution_id = x.id)
      and not exists (
        select 1 from runs r where r.execution_id = x.id
          and r.status in ('queued', 'running', 'awaiting_approval')
      )
      and not exists (
        select 1 from events e join outbox o on o.event_id = e.event_id
        where e.execution_id = x.id and o.status = 'pending'
      )
    returning x.id
  `);
  return result.rows.map((row) => row.id);
}
