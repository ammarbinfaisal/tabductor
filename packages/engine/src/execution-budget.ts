import { publish } from "@tabductor/bus";
import { workflowExecutions, type Db } from "@tabductor/db";
import { and, eq, lt, sql } from "drizzle-orm";

export const RUN_BUDGET_EXCEEDED = "system.run_budget_exceeded";

/** Call in the run-insertion transaction, after delivery/retry deduplication. */
export async function admitExecutionRun(trx: Db, input: {
  executionId: string | null;
  taskId: string;
  causationId: string | null;
  sourceRunId?: string;
  notice?: boolean;
}): Promise<boolean> {
  if (!input.executionId) return true; // legacy routing; new triggers always have an execution
  const admitted = await trx.update(workflowExecutions).set({
    admittedRuns: sql`${workflowExecutions.admittedRuns} + 1`,
  }).where(and(
    eq(workflowExecutions.id, input.executionId),
    eq(workflowExecutions.status, "running"),
    lt(workflowExecutions.admittedRuns, workflowExecutions.maxRuns),
  )).returning({ id: workflowExecutions.id });
  if (admitted.length) return true;
  const [execution] = await trx.select().from(workflowExecutions).where(eq(workflowExecutions.id, input.executionId));
  if (execution?.status === "running" && input.notice !== false) {
    await publish(trx, {
      type: RUN_BUDGET_EXCEEDED, executionId: input.executionId,
      sourceTaskId: input.taskId, sourceRunId: input.sourceRunId,
      causationId: input.causationId,
      packet: { taskId: input.taskId, maxRuns: execution.maxRuns },
    });
  }
  return false;
}
