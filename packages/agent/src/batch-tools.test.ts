import { expect, it, vi } from "vitest";
import type { RunSession } from "@tabductor/browser";
import { buildToolRegistry } from "./tools.js";

function fixture(emit = vi.fn(async (_type: string, _packet: unknown, _key?: string) => ({ outcome: "published" as const, eventId: "event" }))) {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i), author: `author-${i}`, text: `item-${i}` }));
  const session = { page: { queryAll: vi.fn(async (_selector, _fields, opts) => rows.slice(opts.offset ?? 0, (opts.offset ?? 0) + opts.limit)),
    perceive: async () => ({ url: "https://fixture.test", title: "Fixture", text: "", elements: [] }) },
    resolveAnchor: () => "main" } as unknown as RunSession;
  let saved: unknown = null;
  const tools = new Map(buildToolRegistry({ session, emit, checkpoint: { get: async () => saved, set: async (value) => { saved = value; } } }).map((tool) => [tool.name, tool]));
  return { tools, session, emit };
}

it("collects and emits 100 unique records in bounded code without returning bulk data to the model", async () => {
  const { tools, emit } = fixture();
  const result = await tools.get("browser.code")!.execute({ source: `export default async function(tools) {
    let emitted = 0;
    for (let offset = 0; offset < 100; offset += 25) {
      const batch = await tools.call('page.extractBatch', {selector: 'article', fields: {id: {attr:'id'}}, offset, limit:25});
      if (!batch.ok) throw new Error(batch.error);
      const data = await tools.call('batch.read', {batchId: batch.value.batchId, limit:100});
      const out = await tools.call('emit.batch', {type:'item.found', items:data.value.records.map(record => ({packet:record, dedupeKey:record.id}))});
      if (!out.ok) throw new Error(out.error);
      emitted += out.value.count;
      await tools.call('checkpoint.set', {value: {emitted, nextOffset:offset+25}});
      await tools.call('batch.release', {batchId:batch.value.batchId});
    }
    return {emitted};
  }` });
  expect(result).toEqual({ ok: true, value: { emitted: 100 } });
  expect(emit).toHaveBeenCalledTimes(100);
  expect(new Set(emit.mock.calls.map((call) => call[2])).size).toBe(100);
  expect(await tools.get("checkpoint.get")!.execute({})).toEqual({ ok: true, value: { emitted: 100, nextOffset: 100 } });
});

it("reads extracted rows and normalizes tweet URLs before emitting acknowledged records", async () => {
  const { tools, session, emit } = fixture();
  vi.mocked(session.page.queryAll).mockResolvedValue([
    { url: "/author/status/123?ref=feed#details", text: "First tweet" },
    { url: "https://x.com/author/status/456", text: "Second tweet" },
    { url: "/author/status/123", text: "Repeated tweet" },
  ]);
  const batch = await tools.get("page.extractBatch")!.execute({ selector: "article", fields: { url: {attr: "href"}, text: {} } });
  expect(batch.ok).toBe(true);
  const { batchId } = batch.value as { batchId: string };
  const result = await tools.get("browser.code")!.execute({ source: `export default async function(tools) {
    const result = await tools.call('batch.read', {batchId: ${JSON.stringify(batchId)}});
    if (!result.ok) throw new Error(result.error);
    const items = [], seen = new Set();
    for (const row of result.value.records) {
      const url = new URL(row.url, 'https://x.com');
      url.search = ''; url.hash = '';
      const id = url.pathname.split('/').at(-1);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({packet: {tweet_id: id, tweet_url: url.href, tweet_text: row.text}, dedupeKey: id});
    }
    const emitted = await tools.call('emit.batch', {type: 'tweet.extracted', items});
    if (!emitted.ok) throw new Error(emitted.error);
    await tools.call('checkpoint.set', {value: {emitted: emitted.value.count}});
    return {emitted: emitted.value.count};
  }` });
  expect(result).toEqual({ ok: true, value: { emitted: 2 } });
  expect(emit.mock.calls).toEqual([
    ["tweet.extracted", { tweet_id: "123", tweet_url: "https://x.com/author/status/123", tweet_text: "First tweet" }, "123"],
    ["tweet.extracted", { tweet_id: "456", tweet_url: "https://x.com/author/status/456", tweet_text: "Second tweet" }, "456"],
  ]);
  expect(await tools.get("checkpoint.get")!.execute({})).toEqual({ ok: true, value: { emitted: 2 } });
});

it("reports partial acceptance and can retry with stable dedupe keys", async () => {
  const accepted = new Set<string>();
  let reject = true;
  const tools = new Map(buildToolRegistry({ session: {} as RunSession, emit: async (_type, _packet, key) => {
    if (key === "b" && reject) return { outcome: "rejected", error: "invalid record" };
    if (accepted.has(key!)) return { outcome: "deduped" };
    accepted.add(key!); return { outcome: "published", eventId: key! };
  } }).map((tool) => [tool.name, tool]));
  const input = { type: "item", items: ["a", "b", "c"].map((dedupeKey) => ({ packet: {}, dedupeKey })) };
  expect(await tools.get("emit.batch")!.execute(input)).toMatchObject({ ok: false, value: { failedIndex: 1, accepted: [{ dedupeKey: "a" }] } });
  expect([...accepted]).toEqual(["a"]);
  reject = false;
  expect(await tools.get("emit.batch")!.execute(input)).toMatchObject({ ok: true, value: { count: 3 } });
  expect([...accepted]).toEqual(["a", "b", "c"]);
});

it("rejects recursive code and oversized batches and releases memory explicitly", async () => {
  const { tools, session } = fixture();
  expect(await tools.get("page.extractBatch")!.execute({ selector: "article", fields: {}, limit: 101 })).toMatchObject({ ok: false });
  expect(session.page.queryAll).not.toHaveBeenCalled();
  expect(await tools.get("browser.code")!.execute({ source: `export default async function(tools) { await tools.call('browser.code', {}); }` }))
    .toMatchObject({ ok: false, error: expect.stringContaining("unavailable") });
});

it("stops a batch at cancellation without publishing the remaining records", async () => {
  const abort = new AbortController();
  const emit = vi.fn(async () => { abort.abort(); return { outcome: "published" as const, eventId: "one" }; });
  const { tools } = fixture(emit);
  await expect(tools.get("emit.batch")!.execute({ type: "item", items: ["a", "b"].map((dedupeKey) => ({ packet: {}, dedupeKey })) }, abort.signal)).resolves.toMatchObject({ ok: false });
  expect(emit).toHaveBeenCalledTimes(1);
});

it("journals each accepted item even when cancellation interrupts a batch", async () => {
  const abort = new AbortController();
  let journal: unknown = null;
  const tools = new Map(buildToolRegistry({ session: {} as RunSession,
    progress: { get: async () => journal, set: async value => { journal = value; } },
    emit: async () => { abort.abort(); return { outcome: "published", eventId: "accepted" }; },
  }).map(tool => [tool.name, tool]));
  const result = await tools.get("emit.batch")!.execute({ type: "item", items: ["a", "b"].map(dedupeKey => ({ packet: {}, dedupeKey })) }, abort.signal);
  expect(result.ok).toBe(false);
  expect((await tools.get("code.status")!.execute({})).value).toMatchObject({ lastBatch: {
    acceptedCount: 1, total: 2, accepted: [{ index: 0, outcome: "published", keyHash: expect.stringMatching(/^[a-f0-9]{64}$/) }],
  } });
});

it("resumes interrupted reads but fences unresolved browser writes across code invocations", async () => {
  let journal: unknown = { inFlight: { tool: "page.perceive" } };
  const tools = new Map(buildToolRegistry({ session: {} as RunSession, emit: async () => ({ outcome: "deduped" }),
    progress: { get: async () => journal, set: async value => { journal = value; } },
  }).map(tool => [tool.name, tool]));
  const source = "export default async function() { return 'resumed'; }";
  expect(await tools.get("browser.code")!.execute({ source })).toEqual({ ok: true, value: "resumed" });
  expect(await tools.get("browser.code")!.execute({ source })).toEqual({ ok: true, value: "resumed" });
  journal = { inFlight: { tool: "page.click" } };
  expect(await tools.get("browser.code")!.execute({ source })).toEqual({ ok: true, value: "resumed" });
  expect(journal).toMatchObject({ requiresReconciliation: true, inFlight: null });
});
