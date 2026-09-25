import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExtractedRecord, RunSession } from "@tabductor/browser";
import { defineTool, type AgentTool, type EmitFn } from "./tools.js";

export type CheckpointStore = { get: () => Promise<unknown>; set: (value: unknown) => Promise<void> };

/** Batches live outside conversation history and are scoped to this executor invocation.
 * Never silently evict data: callers release batches explicitly once processed.
 */
export function batchTools(session: RunSession, emit: EmitFn,
  signal?: AbortSignal, progress?: CheckpointStore): AgentTool[] {
  const batches = new Map<string, { records: ExtractedRecord[]; bytes: number }>();
  let bytes = 0;
  const fields = z.record(z.string().max(100), z.object({ selector: z.string().max(2000).optional(), attr: z.string().max(100).optional() }))
    .refine((value) => Object.keys(value).length <= 32, "at most 32 fields");
  const batchId = z.string().min(1);
  return [
    defineTool({
      name: "page.extractBatch",
      description: "Extract up to 100 repeated items using a Playwright item selector relative to an optional container anchor. Fields are relative to each item. Returns a batchId, count and two-record preview; full records stay outside model history. Use batch.read in browser.code, then emit.batch. Offset is only for the current DOM, not a durable feed cursor. Release processed batches.",
      parameters: z.object({ anchor: z.string().optional(), selector: z.string().min(1).max(2000), fields,
        offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(100).default(25),
        maxFieldChars: z.number().int().min(1).max(16000).default(4000) }),
      async execute(args) {
        if (batches.size >= 8 || bytes >= 4_000_000) return { ok: false, error: "batch storage full; release processed batches" };
        const root = args.anchor ? session.resolveAnchor(args.anchor) : undefined;
        if (args.anchor && !root) return { ok: false, error: "stale anchor; perceive again" };
        const records = await session.page.queryAll(root ? `${root} >> ${args.selector}` : args.selector, args.fields, args);
        const size = Buffer.byteLength(JSON.stringify(records));
        if (size > 1_000_000 || bytes + size > 4_000_000) return { ok: false, error: "batch too large; use fewer rows or fields" };
        const id = `batch_${randomUUID()}`;
        batches.set(id, { records, bytes: size }); bytes += size;
        return { ok: true, value: { batchId: id, count: records.length, nextOffset: args.offset + records.length,
          pageFull: records.length === args.limit, preview: JSON.stringify(records.slice(0, 2)).slice(0, 3000) } };
      },
    }),
    defineTool({ name: "batch.read", description: "Read a slice of a batch. Returns {ok:true,value:{records:[...],count}}; count is the total batch size. Inside browser.code: const result = await tools.call('batch.read', {batchId}); if (!result.ok) throw new Error(result.error); for (const row of result.value.records) { /* process row */ }. Iterate result.value.records, not result or result.value. Prefer reading inside browser.code to keep records outside model history.",
      parameters: z.object({ batchId, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(25) }),
      async execute(args) {
        const batch = batches.get(args.batchId);
        return batch ? { ok: true, value: { records: batch.records.slice(args.offset, args.offset + args.limit), count: batch.records.length } }
          : { ok: false, error: "batch unavailable; batches expire when this run's browser executor ends" };
      } }),
    defineTool({ name: "batch.release", description: "Release a processed batch's memory. Does not undo accepted events.",
      parameters: z.object({ batchId }), async execute(args) {
        const batch = batches.get(args.batchId);
        if (batch) { bytes -= batch.bytes; batches.delete(args.batchId); }
        return { ok: true, value: { released: Boolean(batch) } };
      } }),
    defineTool({ name: "emit.batch", description: "Durably emit up to 100 individual records, each with a required stable dedupeKey. Validates each event normally. Stops at the first rejected record and returns accepted acknowledgements plus failedIndex; retry only after inspecting this result. Acceptance does not mean downstream completion.",
      parameters: z.object({ type: z.string().min(1), items: z.array(z.object({ packet: z.unknown(), dedupeKey: z.string().min(1).max(2000) })).min(1).max(100) }),
      async execute(args, callSignal) {
        if (Buffer.byteLength(JSON.stringify(args)) > 1_000_000) return { ok: false, error: "emit batch exceeds 1 MB" };
        const accepted: Array<{ index: number; dedupeKey: string; outcome: "published" | "deduped" }> = [];
        for (const [index, item] of args.items.entries()) {
          signal?.throwIfAborted();
          callSignal?.throwIfAborted();
          const result = await emit(args.type, item.packet, item.dedupeKey);
          if (result.outcome === "rejected") return { ok: false, error: result.error, value: { accepted, failedIndex: index } };
          accepted.push({ index, dedupeKey: item.dedupeKey, outcome: result.outcome });
          if (progress) {
            const current = await progress.get() as Record<string, unknown> | null;
            await progress.set({ ...current, lastBatch: { type: args.type, acceptedCount: accepted.length, total: args.items.length,
              // Keep a bounded exact index/hash journal; durable bus dedupe retains every key.
              accepted: accepted.slice(-25).map(item => ({ index: item.index, keyHash: createHash("sha256").update(item.dedupeKey).digest("hex"), outcome: item.outcome })) } });
          }
        }
        return { ok: true, value: { accepted, count: accepted.length } };
      } }),
  ];
}
