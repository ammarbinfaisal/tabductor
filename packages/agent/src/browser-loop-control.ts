import { and, eq } from "drizzle-orm";
import { taskState, type Db } from "@tabductor/db";
import { assertRunLease, type RunHandle } from "@tabductor/engine";
import type { BrowserConn, RunSession } from "@tabductor/browser";
import { summarizePerception } from "./tools.js";
import { AppError } from "@tabductor/core";

export function browserLoopControl(db: Db, handle: RunHandle, conn: BrowserConn, session: RunSession) {
  const key = `agent-checkpoint:${handle.run.triggerEventId ?? handle.run.id}`;
  const store = (stateKey: string) => ({
    async get() {
      const [row] = await db.select({value:taskState.value}).from(taskState).where(and(eq(taskState.taskId,handle.task.id),eq(taskState.key,stateKey)));
      return row?.value ?? null;
    },
    async set(value: unknown) {
      if (JSON.stringify(value).length > 24000) throw new Error("exploration memory exceeds 24000 characters");
      await db.transaction(async trx => {
        await assertRunLease(trx,handle.run.id,handle.run.leaseGeneration);
        await trx.insert(taskState).values({taskId:handle.task.id,key:stateKey,value:value as Record<string,unknown>})
          .onConflictDoUpdate({target:[taskState.taskId,taskState.key],set:{value:value as Record<string,unknown>}});
      });
    },
  });
  return {
    workspace: store(`agent-workspace:${handle.run.id}`),
    context: store(`agent-context:${handle.run.triggerEventId ?? handle.run.id}`),
    actions: store(`agent-actions:${handle.run.triggerEventId ?? handle.run.id}`),
    memory: store(`agent-memory:${handle.run.triggerEventId ?? handle.run.id}`),
    progress: store(`agent-code-progress:${handle.run.triggerEventId ?? handle.run.id}`),
    async beforeStep() {
      for (;;) {
        handle.signal.throwIfAborted();
        if (!await conn.waitForAutomation?.(handle.signal)) return undefined;
        try { return summarizePerception(await session.page.perceive()); }
        catch (error) {
          // Takeover may race the refresh itself. Wait for the next generation instead
          // of turning a control transition into a failed workflow.
          if (!(error instanceof AppError) || !["browser_input_revoked", "browser_fresh_perception_required"].includes(error.code)) throw error;
        }
      }
    },
    checkpoint: {
      async get() {
        const [row] = await db.select({ value: taskState.value }).from(taskState)
          .where(and(eq(taskState.taskId, handle.task.id), eq(taskState.key, key)));
        return row?.value ?? null;
      },
      async set(value: unknown) {
        await db.transaction(async (trx) => {
          await assertRunLease(trx, handle.run.id, handle.run.leaseGeneration);
          await trx.insert(taskState).values({ taskId: handle.task.id, key, value: value as Record<string, unknown> })
            .onConflictDoUpdate({ target: [taskState.taskId, taskState.key], set: { value: value as Record<string, unknown> } });
        });
      },
    },
  };
}
