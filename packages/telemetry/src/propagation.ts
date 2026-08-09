import { context, propagation, trace, type Context, type Span, type Tracer } from "@opentelemetry/api";

/**
 * Trace propagation across the bus (§17.2 rule 3). The outbox row carries a W3C
 * `traceparent`, so a workflow's causal chain — schedule fire → dispatch → run → emit →
 * next dispatch — reads as one distributed trace. It is the operational mirror of
 * `causation_id`: same shape, different audience.
 *
 * Everything here is `@opentelemetry/api` only. That package is inert until a provider is
 * registered, which is what lets `packages/bus` and `packages/engine` carry propagation
 * without ever importing the SDK, and what makes the disabled mode cost nothing.
 */

/** The active span's context in W3C form, or null when nothing is being traced. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

export function contextFromTraceparent(traceparent: string | null): Context | undefined {
  if (!traceparent) return undefined;
  const extracted = propagation.extract(context.active(), { traceparent });
  return trace.getSpanContext(extracted) ? extracted : undefined;
}

/**
 * The consumer span for one delivery.
 *
 * A first delivery is a **child** of the producer: one emit, one dispatch, one edge in the
 * trace. A redelivery is a **root span with a link** back to the producer instead — under
 * at-least-once, one producer span can have several consumer descendants, and modelling the
 * second attempt as another child would draw a fan-out that never happened. A missing or
 * unparseable `traceparent` (a row written before the column existed) starts a root span
 * with no link, never an error.
 */
export function startConsumerSpan(
  tracer: Tracer,
  name: string,
  args: { traceparent: string | null; redelivery: boolean; attributes?: Record<string, string | number> },
): { span: Span; ctx: Context } {
  const parent = contextFromTraceparent(args.traceparent);
  const attributes = args.attributes ?? {};

  if (parent && !args.redelivery) {
    const span = tracer.startSpan(name, { attributes }, parent);
    return { span, ctx: trace.setSpan(parent, span) };
  }

  const links = parent ? [{ context: trace.getSpanContext(parent)! }] : [];
  const span = tracer.startSpan(name, { attributes, links, root: true });
  return { span, ctx: trace.setSpan(context.active(), span) };
}

/** Run `fn` inside `span`, closing it either way and recording a failure as one. */
export async function inSpan<T>(span: Span, ctx: Context, fn: () => Promise<T>): Promise<T> {
  try {
    return await context.with(ctx, fn);
  } catch (err) {
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    span.setStatus({ code: 2 /* ERROR */ });
    throw err;
  } finally {
    span.end();
  }
}
