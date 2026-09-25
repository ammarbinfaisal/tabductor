import { createHash } from "node:crypto";
import type { BlobStore } from "@tabductor/browser";
import type { CheckpointStore } from "./batch-tools.js";
import type { LlmMessage } from "./llm.js";

export type SdkHistoryEntry = {
  operationId: string; invocationId: string; name: string; effect: boolean;
  sdkCallId?: number; parentHelper?: unknown;
  layer?: "gateway" | "python-sdk";
  args: unknown; result: unknown;
};
type Link = { sequence: number; ref: string };
type ArchivedEntry = SdkHistoryEntry & { sequence: number; previous?: Link };
type HistoryState = { head?: Link; summarizedThrough?: number; summary?: string; conversationRef?: string };
export type HistoryPreview = Omit<SdkHistoryEntry, "args" | "result"> & { sequence: number; args: unknown; result: unknown };

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
function visiblePreview(value: unknown): unknown {
  const item = object(value);
  if (item.omitted !== true || typeof item.preview !== "string") return value;
  const { digest: _digest, ...visible } = item;
  return visible;
}

/** Presentation only. The immutable archive still contains every wrapper and host call. */
export function contextOperations(entries: HistoryPreview[]): HistoryPreview[] {
  const gateways = new Map<string, HistoryPreview[]>();
  for (const entry of entries) if (entry.layer === "gateway" && entry.sdkCallId !== undefined) {
    const key = `${entry.invocationId}:${entry.sdkCallId}`;
    gateways.set(key, [...gateways.get(key) ?? [], entry]);
  }
  return entries.flatMap(entry => {
    const result = object(entry.result);
    const nested = gateways.get(`${entry.invocationId}:${entry.sdkCallId}`);
    // Only collapse identical successful results. Wrapper-only exceptions and transformed
    // helper results contain additional evidence and must remain visible.
    if (entry.layer === "python-sdk" && result.ok === true && nested?.length === 1 &&
        JSON.stringify(nested[0]!.result) === JSON.stringify(entry.result)) return [];
    const presented = { ...entry, args: visiblePreview(entry.args), result: visiblePreview(entry.result) };
    if (entry.name === "workspace.commit" && result.ok === true) {
      return [{ ...presented, args: { omitted: true, guidance: "Automatic file persistence; full files in workspace.read or history.read." } }];
    }
    return [presented];
  });
}

function preview(value: unknown, limit: number): unknown {
  const serialized = JSON.stringify(value) ?? "null";
  const status = value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => ["ok", "code", "outcomeUncertain"].includes(key))) : {};
  return serialized.length <= limit ? value : { ...status, preview: serialized.slice(0, limit), characters: serialized.length,
    digest: createHash("sha256").update(serialized).digest("hex"),
    omitted: true, guidance: "Read the full operation with history.read(sequence=..., offset=...). Do not infer absent data." };
}

/** Full redacted evidence is immutable; only the small run-scoped manifest is mutable.
 * Compaction never deletes archived operations. The model cannot edit this manifest. */
export function createContextHistory(blobs: BlobStore, store: CheckpointStore) {
  const cache = new Map<number, ArchivedEntry>();
  const sizes = new Map<number, number>();
  let cacheBytes = 0;
  function cacheEntry(saved: ArchivedEntry) {
    if (cache.has(saved.sequence)) return;
    const bytes = Buffer.byteLength(JSON.stringify(saved));
    if (bytes > 8_000_000) return;
    cache.set(saved.sequence, saved); sizes.set(saved.sequence, bytes); cacheBytes += bytes;
    while (cache.size > 256 || cacheBytes > 8_000_000) {
      const sequence = cache.keys().next().value!;
      cacheBytes -= sizes.get(sequence)!; sizes.delete(sequence); cache.delete(sequence);
    }
  }
  const state = async () => (await store.get() ?? {}) as HistoryState;
  async function entry(link: Link): Promise<ArchivedEntry> {
    const saved = cache.get(link.sequence) ?? JSON.parse((await blobs.get(link.ref)).toString()) as ArchivedEntry;
    cacheEntry(saved);
    return saved;
  }
  async function pending(): Promise<HistoryPreview[]> {
    const current = await state(), items: HistoryPreview[] = [];
    for (let link = current.head; link && link.sequence > (current.summarizedThrough ?? 0);) {
      const { previous, ...saved } = await entry(link);
      items.push({ ...saved, args: preview(saved.args, 800), result: preview(saved.result, 2400) });
      link = previous;
    }
    return items.reverse();
  }
  return {
    async append(operation: SdkHistoryEntry) {
      const current = await state();
      const saved: ArchivedEntry = { ...operation, sequence: (current.head?.sequence ?? 0) + 1, previous: current.head };
      const ref = await blobs.put(Buffer.from(JSON.stringify(saved)), { mime: "application/json" });
      cacheEntry(saved);
      await store.set({ ...current, head: { sequence: saved.sequence, ref } });
    },
    pending,
    async summary() { return (await state()).summary ?? ""; },
    async messages(): Promise<LlmMessage[] | undefined> {
      const ref = (await state()).conversationRef;
      return ref ? JSON.parse((await blobs.get(ref)).toString()) as LlmMessage[] : undefined;
    },
    async saveMessages(messages: LlmMessage[]) {
      // Reconstruct live context on every turn instead of persisting a duplicate journal.
      const saved = messages.map(({ contextMemory: _contextMemory, ...message }) => message);
      const conversationRef = await blobs.put(Buffer.from(JSON.stringify(saved)), { mime: "application/json" });
      await store.set({ ...await state(), conversationRef });
    },
    async compact(summary: string, through: number | undefined, messages: LlmMessage[]) {
      const saved = messages.map(({ contextMemory: _contextMemory, ...message }) => message);
      const conversationRef = await blobs.put(Buffer.from(JSON.stringify(saved)), { mime: "application/json" });
      const current = await state();
      await store.set({ ...current, summary, conversationRef, summarizedThrough: through ?? current.summarizedThrough ?? 0 });
    },
    async read(args: { sequence?: number; before?: number; offset: number; limit: number;
      name?: string; invocationId?: string; query?: string; failedOnly?: boolean }) {
      const current = await state();
      const recent: Array<{ sequence: number; name: string; effect: boolean; operationId: string; invocationId: string;
        ok?: unknown; code?: unknown; excerpt?: string }> = [];
      let scanned = 0, nextBefore: number | null = null;
      for (let link = current.head; link;) {
        const saved = await entry(link);
        if (args.sequence === saved.sequence) {
          const { previous: _previous, ...operation } = saved;
          const text = JSON.stringify(operation);
          return { sequence: saved.sequence, text: text.slice(args.offset, args.offset + args.limit), characters: text.length,
            nextOffset: args.offset + args.limit < text.length ? args.offset + args.limit : null };
        }
        if (args.sequence === undefined && saved.sequence < (args.before ?? Infinity)) {
          scanned++;
          nextBefore = previousCursor(saved);
          const result = object(saved.result);
          const matches = (!args.name || saved.name === args.name) && (!args.invocationId || saved.invocationId === args.invocationId) &&
            (!args.failedOnly || result.ok === false);
          const evidence = matches && args.query ? JSON.stringify({ args: saved.args, result: saved.result }) : "";
          const found = args.query ? evidence.toLowerCase().indexOf(args.query.toLowerCase()) : -1;
          if (matches && (!args.query || found >= 0)) recent.push({ sequence: saved.sequence, name: saved.name, effect: saved.effect,
            operationId: saved.operationId, invocationId: saved.invocationId, ok: result.ok, code: result.code,
            ...(args.query ? { excerpt: evidence.slice(Math.max(0, found - 80), found + 240) } :
              result.ok === false ? { excerpt: String(result.error ?? "").slice(0, 240) } : {}) });
          // Bounded scans can return an empty page with a cursor; callers can continue.
          if (recent.length === 20 || scanned === 200) break;
        }
        link = saved.previous;
      }
      if (args.sequence !== undefined) throw new Error("SDK operation is not in this run's history");
      return { operations: recent, nextBefore, scanned, latestSequence: current.head?.sequence ?? 0 };
    },
  };
}
function previousCursor(entry: ArchivedEntry) { return entry.previous ? entry.sequence : null; }
export type ContextHistory = ReturnType<typeof createContextHistory>;
