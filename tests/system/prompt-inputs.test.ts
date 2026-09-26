import { afterAll, beforeAll, expect, it } from "vitest";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { events, runs, tasks, workflowExecutions } from "@tabductor/db";
import { eq } from "drizzle-orm";
import { publish } from "@tabductor/bus";
import { dispatchEvent, staticSchemaGenerator, type RunHandle } from "@tabductor/engine";
import { createCaller } from "../../apps/web/src/server/router.js";
import { createWorkflowControl } from "../../apps/web/src/server/workflow-mcp.js";
import { triggerInfoOf } from "../../packages/agent/src/executor-shared.js";

let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });

it("validates manual inputs and preserves them across downstream tasks and concurrent executions", async () => {
  const ctx = { db: handle.db, schemaGenerator: staticSchemaGenerator() };
  const api = createCaller(ctx);
  const workflowId = await api.workflow.create({ name: "Prompt inputs" });
  await api.workflow.publishVersion({ workflowId, graph: {
    contractVersion: 2, externalInputs: [], systemInputs: [], maxRuns: 10, automationPrompt: "Read about $topic and write in $reply-style", tasks: [
      { logicalId: "read", name: "Read", entry: true, mode: "stub", prompt: "Read about $topic", emits: ["read.done"], consumes: [] },
      { logicalId: "write", name: "Write", entry: false, mode: "stub", prompt: "Write in $reply-style", emits: [], consumes: ["read.done"] },
    ], events: [{ type: "read.done", description: "An observed article", public: false }],
  } });
  const invalidInputs: Array<Record<string, string> | undefined> = [undefined, { topic: "gardening" }, { topic: " ", "reply-style": "friendly" }, { topic: "gardening", "reply-style": "friendly", extra: "unexpected" }];
  for (const inputs of invalidInputs) {
    await expect(api.workflow.trigger({ workflowId, inputs })).rejects.toThrow();
  }
  expect(await handle.db.select().from(workflowExecutions).where(eq(workflowExecutions.workflowId, workflowId))).toHaveLength(0);
  const inputs = { topic: "gardening", "reply-style": "friendly" };
  const first = await api.workflow.trigger({ workflowId, inputs, requestId: "first" });
  expect(await api.workflow.trigger({ workflowId, inputs, requestId: "first" })).toEqual(first);
  await createWorkflowControl(ctx).trigger({ workflowId, inputs: { topic: "astronomy", "reply-style": "formal" } });
  const [root] = await handle.db.select().from(events).where(eq(events.eventId, first.runs[0]!.eventId));
  expect(root!.packet).toEqual({ promptInputs: inputs });
  const packet = { article: "Observed text", promptInputs: { topic: "wrong execution" } };
  const next = await publish(handle.db, { type: "read.done", executionId: first.executionId, sourceTaskId: root!.sourceTaskId, sourceRunId: first.runs[0]!.runId!, packet });
  const [dispatched] = await dispatchEvent(handle.db, next);
  const [run] = await handle.db.select().from(runs).where(eq(runs.id, dispatched!.runId));
  const [task] = await handle.db.select().from(tasks).where(eq(tasks.id, dispatched!.taskId));
  const trigger = await triggerInfoOf(handle.db, { task, run, trigger: next } as RunHandle);
  expect(trigger?.packet).toEqual({ article: "Observed text", promptInputs: inputs });
});
