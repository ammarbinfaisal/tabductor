import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../../../../server/router.js";
import { createContext } from "../../../../server/trpc.js";

/** The one HTTP surface: no REST duplication, no versioning (S2c). */
const handler = (req: Request): Promise<Response> =>
  fetchRequestHandler({ endpoint: "/api/trpc", req, router: appRouter, createContext });

export { handler as GET, handler as POST };
