import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";
import type { AppRouter } from "../server/router.js";

const connectionMessage = () => typeof navigator !== "undefined" && navigator.onLine === false
  ? "No internet connection. Check your connection and try again."
  : "Could not reach Tabductor. Check your internet connection and try again.";

const transportFailure = /(?:failed to fetch|networkerror|network request failed|unexpected end of json input|is not valid json)/i;

/** tRPC otherwise calls `Response.json()` itself, which turns an empty proxy/offline
 * response into a misleading JSON parser error. Preserve server error bodies, but fail
 * fast with a connection message when there is no body to parse. */
async function trpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    throw new Error(connectionMessage(), { cause: error });
  }
  if (!(await response.clone().text()).trim()) throw new Error(connectionMessage());
  return response;
}

/**
 * The vanilla tRPC client — plain promises, no React Query, no hooks (ROADMAP stack rules).
 * Store actions call it; components call store actions.
 *
 * `import type` on the router is load-bearing: it is erased at compile time, so importing
 * the server's types here does not drag Postgres into the browser bundle.
 */
export const api = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc", transformer: superjson, fetch: trpcFetch })],
});

/**
 * What each procedure returns, so a component can name a shape without re-declaring one that
 * would then drift from the router.
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/** tRPC's error payload, narrowed to the bit the UI renders: the message and `AppError.details`. */
export type ApiError = { message: string; details: Record<string, unknown> };

export function asApiError(err: unknown): ApiError {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = transportFailure.test(rawMessage) ? connectionMessage() : rawMessage;
  const data = (err as { data?: { appError?: { details?: Record<string, unknown> } } }).data;
  return { message, details: data?.appError?.details ?? {} };
}
