import { headers } from "next/headers";
import { createCaller } from "./router.js";
import { db } from "./db.js";
import { metricsNow } from "./metrics.js";
import { schemaGenerator } from "./schema-generator.js";

/**
 * A caller for the public share pages (U0.5).
 *
 * Server components render through `createCaller` rather than fetching our own HTTP
 * endpoint, so this is the composition point that supplies what a request carries: an
 * address for the rate limiter and the metrics handle. Without it a page load would be the
 * one public read that neither counts nor costs anything to repeat.
 */
export async function shareCaller(): Promise<ReturnType<typeof createCaller>> {
  const h = await headers();
  const metrics = metricsNow();
  return createCaller({
    db: db(),
    schemaGenerator: schemaGenerator(),
    clientKey: clientKeyOf(h),
    ...(metrics ? { metrics } : {}),
  });
}

/**
 * `x-forwarded-for` is trivially spoofable when nothing trusted sets it, so this is a speed
 * bump against casual scraping and not an authorization input — nothing is granted or denied
 * by it, only slowed.
 */
function clientKeyOf(h: Headers): string {
  const forwarded = h.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}
