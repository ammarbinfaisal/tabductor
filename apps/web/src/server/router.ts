import { endpointRouter } from "./routers/endpoint.js";
import { engineRouter } from "./routers/engine.js";
import { eventRouter } from "./routers/event.js";
import { publicRouter } from "./routers/public.js";
import { runRouter } from "./routers/run.js";
import { shareRouter } from "./routers/share.js";
import { storeRouter } from "./routers/store.js";
import { taskRouter } from "./routers/task.js";
import { workflowRouter } from "./routers/workflow.js";
import { accountRouter } from "./routers/account.js";
import { browserSessionRouter } from "./routers/browser-session.js";
import { createCallerFactory, createContext, router, type Context } from "./trpc.js";
import { accountIdForWebRequest } from "./auth-context.js";

export const appRouter = router({
  account: accountRouter,
  browserSession: browserSessionRouter,
  workflow: workflowRouter,
  task: taskRouter,
  run: runRouter,
  event: eventRouter,
  share: shareRouter,
  /** cdp_endpoints health (U1.5) + per-workflow endpoint lists (U3a); ws_url filtered out at the query. */
  endpoint: endpointRouter,
  /** Which executors the engine registered, and whether it is alive (U3a). */
  engine: engineRouter,
  /** The store browser + query console (U3.5) — every procedure routes through
   * `@tabductor/store`'s fenced read path; see `routers/store.ts`'s own doc comment. */
  store: storeRouter,
  /** Unauthenticated, token-scoped reads (S2d). Everything under here filters in SQL. */
  public: publicRouter,
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

export async function createServerCaller() {
  return callerFactory({ ...createContext(), accountId: await accountIdForWebRequest() });
}

export type { Context };
