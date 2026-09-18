/**
 * The harness-wide execution model, shared verbatim by graph authoring, publish-time prompt
 * compilation, and every runtime agent loop. Keeping one versioned string prevents one model
 * phase from quietly turning the event graph back into a synchronous pipeline.
 */
export const ASYNC_EVENT_EXECUTION_CONTRACT = `Each task run is an independently scheduled consumer of one trigger. Runs communicate only through durable typed events. Emitting a packet records an asynchronous handoff and returns without waiting for any consumer. When work yields independent items, emit each complete item immediately with a stable source identity or dedupe key, then continue producing remaining items. Every consumer processes its triggering item independently and idempotently; consumers may run concurrently and must not assume event ordering, shared memory, or a shared browser tab. Put work on different sites or systems in separate tasks connected by events. A consumes list is not a join. Use aggregation only when the requested result genuinely requires it, with an explicit correlation id, durable state, and completion event.`;
