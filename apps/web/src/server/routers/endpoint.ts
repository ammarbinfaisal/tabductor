import { listCdpEndpoints } from "@tabductor/engine";
import { procedure, router } from "../trpc.js";

/**
 * The endpoint health panel (U1.5). One procedure: `cdp_endpoints` has no per-workflow
 * scope (§8 — one connection per user CDP endpoint), so there is nothing to filter by yet
 * in this single-user subphase.
 *
 * `listCdpEndpoints` selects `ws_url` out of the query entirely (techical_plan §16
 * Threat 5) — this router adds no shaping of its own, on purpose: a second place that
 * "also" strips the field is a second place that can forget to.
 */
export const endpointRouter = router({
  list: procedure.query(({ ctx }) => listCdpEndpoints(ctx.db)),
});
