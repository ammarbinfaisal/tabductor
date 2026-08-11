import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../../../../server/router.js";
import { db } from "../../../../server/db.js";
import { metricsNow } from "../../../../server/metrics.js";
import { schemaGenerator } from "../../../../server/schema-generator.js";
import type { Context } from "../../../../server/trpc.js";

/** The one HTTP surface: no REST duplication, no versioning (S2c). */
const handler = (req: Request): Promise<Response> =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    /**
     * This is the composition point for a *request*: it is the only place that has an
     * address to rate-limit and the only place allowed to reach for telemetry, which the
     * routers receive by injection rather than import (§17.2 rule 1).
     */
    createContext: (): Context => {
      const metrics = metricsNow();
      return {
        db: db(),
        schemaGenerator: schemaGenerator(),
        clientKey: clientKeyOf(req),
        ...(metrics ? { metrics } : {}),
      };
    },
  });

/**
 * A coarse caller identity for the public path's rate limiter (S2d).
 *
 * `x-forwarded-for` is trivially spoofable when nothing trusted sets it, so this is a
 * speed bump against casual scraping rather than an authorization input — nothing is
 * granted or denied by it, only slowed. The remote address is not available through the
 * fetch adapter, so the header is what there is.
 */
function clientKeyOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export { handler as GET, handler as POST };
