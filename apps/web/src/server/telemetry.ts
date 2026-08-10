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
const store = globalThis as {
  __tabductorTelemetry?: Promise<Telemetry>;
  __tabductorTelemetryReady?: Telemetry;
};

export function telemetry(): Promise<Telemetry> {
  store.__tabductorTelemetry ??= initTelemetry({ service: "tabductor-web" }).then((t) => {
    store.__tabductorTelemetryReady = t;
    return t;
  });
  return store.__tabductorTelemetry;
}

/**
 * The resolved handle, or undefined before `register()` has finished.
 *
 * Request handling is synchronous at the point a context is built, and `instrumentation.ts`
 * awaits init at boot — so by the first request this is set. Returning undefined rather
 * than awaiting keeps a missing collector from ever being a reason a request blocks.
 */
export function telemetryNow(): Telemetry | undefined {
  return store.__tabductorTelemetryReady;
}
