import { AppError } from "@tabductor/core";
import {
  addWorkflowEndpoint,
  listCdpEndpoints,
  listWorkflowEndpoints,
  removeWorkflowEndpoint,
  reorderWorkflowEndpoints,
  updateWorkflowEndpoint,
} from "@tabductor/engine";
import { z } from "zod";
import { procedure, router } from "../trpc.js";

/**
 * CDP endpoints: the global health panel (U1.5) and, since U3a, each workflow's own ordered
 * list — its "Browser endpoints" setting — that the engine rotates browser runs across.
 *
 * Every query here goes through `queries.ts` projections that select `ws_url` *out* of the
 * column list (techical_plan §16 Threat 5). This router adds no shaping of its own, on
 * purpose: a second place that "also" strips the field is a second place that can forget
 * to. The URL goes in through `add` and never comes back out.
 */
/**
 * What a user may paste for an endpoint.
 *
 * `http://host:port` is the form to prefer, and the placeholder says so: the DevTools GUID in
 * a `ws://` URL is regenerated on every browser restart, so a `ws://` endpoint stops working
 * the next time the user quits Chrome — while an HTTP address is re-resolved through
 * `/json/version` on each connect (`resolveCdpWsUrl`) and survives. It is also the URL people
 * already have, rather than 76 characters of hex to copy without clipping the last one.
 *
 * `ws://` stays accepted for endpoints added before this and for anything fronting CDP with
 * no `/json/version` to ask.
 *
 * Deliberately *not* validated for reachability here. A save that probes the network is a
 * save that fails when the browser happens to be closed, and the address is often entered
 * before the browser it names is running. `resolveCdpWsUrl` is the thing that finds out, at
 * connect time, and `cdp_endpoints.healthy` is where that verdict is already recorded.
 */
const ENDPOINT_URL = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (u) => /^(wss?|https?):\/\//.test(u),
    "must be the browser's HTTP address (e.g. http://127.0.0.1:9222) or a ws:// URL",
  );

export const endpointRouter = router({
  list: procedure.query(({ ctx }) => listCdpEndpoints(ctx.db)),

  listForWorkflow: procedure
    .input(z.object({ workflowId: z.string().min(1) }))
    .query(({ ctx, input }) => listWorkflowEndpoints(ctx.db, input.workflowId)),

  add: procedure
    .input(z.object({ workflowId: z.string().min(1), wsUrl: ENDPOINT_URL, label: z.string().trim().max(120).optional() }))
    .mutation(({ ctx, input }) =>
      addWorkflowEndpoint(ctx.db, {
        workflowId: input.workflowId,
        wsUrl: input.wsUrl,
        ...(input.label ? { label: input.label } : {}),
      }),
    ),

  /** In-place edit, keeping the endpoint's id and its place in the rotation order. An
   * omitted field is left as it was; an empty `label` clears it. */
  update: procedure
    .input(
      z.object({
        workflowId: z.string().min(1),
        id: z.string().min(1),
        wsUrl: ENDPOINT_URL.optional(),
        label: z.string().trim().max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await updateWorkflowEndpoint(ctx.db, {
        workflowId: input.workflowId,
        id: input.id,
        ...(input.wsUrl === undefined ? {} : { wsUrl: input.wsUrl }),
        ...(input.label === undefined ? {} : { label: input.label === "" ? null : input.label }),
      });
      if (!row) {
        throw new AppError("endpoint_not_found", `no endpoint ${input.id} on this workflow`, {
          details: { id: input.id, workflowId: input.workflowId },
        });
      }
      return row;
    }),

  remove: procedure
    .input(z.object({ workflowId: z.string().min(1), id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => ({ removed: await removeWorkflowEndpoint(ctx.db, input) })),

  reorder: procedure
    .input(z.object({ workflowId: z.string().min(1), ids: z.array(z.string().min(1)).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await reorderWorkflowEndpoints(ctx.db, input);
      return listWorkflowEndpoints(ctx.db, input.workflowId);
    }),
});
