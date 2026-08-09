import { eventRouter } from "./routers/event.js";
import { runRouter } from "./routers/run.js";
import { taskRouter } from "./routers/task.js";
import { workflowRouter } from "./routers/workflow.js";
import { createCallerFactory, createContext, router, type Context } from "./trpc.js";

export const appRouter = router({
  workflow: workflowRouter,
  task: taskRouter,
  run: runRouter,
  event: eventRouter,
});

export type AppRouter = typeof appRouter;

const callerFactory = createCallerFactory(appRouter);

/**
 * The router with no HTTP in front of it. Server components call it directly (no fetch to
 * ourselves), and the system tests drive the same procedures the UI does — which is what
 * makes those tests the API contract (impl-phases, UI-track rule 1).
 */
export function createCaller(ctx: Context = createContext()) {
  return callerFactory(ctx);
}

export type { Context };
