import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";
import type { AppRouter } from "../server/router.js";

/**
 * The vanilla tRPC client — plain promises, no React Query, no hooks (ROADMAP stack rules).
 * Store actions call it; components call store actions.
 *
 * `import type` on the router is load-bearing: it is erased at compile time, so importing
 * the server's types here does not drag Postgres into the browser bundle.
 */
export const api = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
});

/**
 * What each procedure returns, so a component can name a shape without re-declaring one that
 * would then drift from the router.
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/** tRPC's error payload, narrowed to the bit the UI renders: the message and `AppError.details`. */
export type ApiError = { message: string; details: Record<string, unknown> };

export function asApiError(err: unknown): ApiError {
  const message = err instanceof Error ? err.message : String(err);
  const data = (err as { data?: { appError?: { details?: Record<string, unknown> } } }).data;
  return { message, details: data?.appError?.details ?? {} };
}
