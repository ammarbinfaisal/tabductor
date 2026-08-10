import type { Metrics } from "@tabductor/telemetry";

/**
 * The metrics handle, reachable from bundled code (U0.5).
 *
 * This file exists because of a bundling constraint SOb already paid for once:
 * `server/telemetry.ts` imports `@tabductor/telemetry/init`, and the OTel SDK's module graph
 * does not survive webpack — it reaches `@grpc/grpc-js`, which requires `net`. So anything
 * on a bundled path (a route handler, a server component) must not import that module, even
 * for a type.
 *
 * `initTelemetry` parks the resolved handle on `globalThis`; this reads it back with a
 * type-only import, which is erased. Same shape as `db.ts`, same reason.
 */
const store = globalThis as { __tabductorTelemetryReady?: { metrics: Metrics } };

export function metricsNow(): Metrics | undefined {
  return store.__tabductorTelemetryReady?.metrics;
}
