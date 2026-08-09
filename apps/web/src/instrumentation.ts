import { telemetry } from "./server/telemetry.js";

/**
 * Next's one boot hook, called once per server process before any request is handled — which
 * makes it this app's composition root for telemetry (§17.2 rule 1).
 *
 * Guarded on the runtime: the edge runtime has no OTel SDK to load, and nothing in this app
 * runs there today.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await telemetry();
}
