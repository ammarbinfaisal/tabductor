import { initTelemetry } from "@tabductor/telemetry/init";
import type { Telemetry } from "@tabductor/telemetry";

/**
 * The web app's composition root for telemetry (§17.2 rule 1). Next has no `main`, so
 * "once per process" is a promise parked on `globalThis` — the same shape `db.ts` uses, and
 * for the same reason: dev re-evaluates modules on every edit, and re-initialising an SDK
 * per save would stack exporters.
 *
 * `src/instrumentation.ts` calls this at boot so init happens before the first request
 * rather than inside it.
 */
const store = globalThis as { __tabductorTelemetry?: Promise<Telemetry> };

export function telemetry(): Promise<Telemetry> {
  store.__tabductorTelemetry ??= initTelemetry({ service: "tabductor-web" });
  return store.__tabductorTelemetry;
}
