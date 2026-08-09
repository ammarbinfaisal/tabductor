import { afterEach, expect, it } from "vitest";
import { initTelemetry } from "@tabductor/telemetry/init";

/**
 * Telemetry is **not** an assertion surface (§17.2 testing posture, and the testing doctrine
 * in `impl-phases.md`): traces and events stay the ground truth for every other suite, and
 * no test here asserts on a span or a metric value. Dashboards are verified by looking at
 * them, which is what they are for.
 *
 * The one property worth a test is the one everything else depends on — that with no OTLP
 * endpoint configured, init is genuinely *inert*. Not "started with exporters disabled":
 * inert. This is the mode CI runs in and the mode a docker-less dev box runs in, and if it
 * ever opened a socket or left a timer behind, every suite in the repo would start hanging
 * on exit and nobody would suspect telemetry.
 */

const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

afterEach(() => {
  if (originalEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
});

/**
 * Handles that would mean §17.2's forbidden "sockets and background work": a network socket,
 * a timer, or a worker thread (which is how pino-pretty pretty-prints, and why it is opt-in).
 *
 * Pipes are deliberately *not* on this list — stdout is one, and writing log lines to it is
 * the disabled mode working, not leaking.
 */
const noisy = (resources: string[]): string[] =>
  resources.filter((r) => /Timeout|Immediate|TCP|Socket|TLS|UDP|MessagePort|Worker/i.test(r));

it("performs no I/O and leaves nothing running when no OTLP endpoint is configured", async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const before = noisy(process.getActiveResourcesInfo());
  const telemetry = await initTelemetry({ service: "telemetry-smoke-test" });
  // A tick, so anything the SDK might have scheduled has had a chance to appear.
  await new Promise((r) => setImmediate(r));
  const after = noisy(process.getActiveResourcesInfo());

  expect(telemetry.enabled).toBe(false);
  // Compared as lists, not counts, so a failure names the handle that appeared.
  expect(after).toEqual(before);

  // Non-recording spans: the API's default, which is how "zero cost" is achieved rather
  // than by branching at every call site.
  const span = telemetry.tracer.startSpan("smoke");
  expect(span.isRecording()).toBe(false);
  span.end();

  // Every instrument still works — a disabled build must not make call sites conditional.
  telemetry.metrics.runs.add({ kind: "browser", mode: "stub", status: "succeeded" });
  telemetry.metrics.runDuration.record(0.5, { kind: "browser", mode: "stub" });
  telemetry.metrics.schedulerFires.add("fired");
  telemetry.metrics.outboxDispatchLag.record(0.01);
  telemetry.metrics.outboxDeadLetters.add();
  telemetry.metrics.eventsDedupeDropped.add();
  telemetry.metrics.crashRecoveredRuns.add(2);

  // An observable gauge whose callback must never be invoked without a collector — this one
  // would query the database forever if it were.
  let observed = 0;
  telemetry.metrics.observeOutboxDepth(async () => {
    observed += 1;
    return 0;
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(observed).toBe(0);

  // `shutdown()` on a disabled telemetry is a no-op that must still be safe to call — the
  // composition roots call it unconditionally.
  await telemetry.shutdown();
  expect(noisy(process.getActiveResourcesInfo())).toEqual(before);
});

it("treats an empty endpoint the same as an unset one", async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "   ";
  const telemetry = await initTelemetry({ service: "telemetry-smoke-test" });
  expect(telemetry.enabled).toBe(false);
  await telemetry.shutdown();
});
