import { expect, it, vi } from "vitest";
import { runToolScript } from "./tool-script.js";

it("isolates browser code from imports and ambient host capabilities", async () => {
  const result = await runToolScript(`export default async function(tools) {
    return [typeof process, typeof require, typeof fetch, typeof WebSocket, typeof setTimeout,
      (function(){}).constructor('return typeof process')()];
  }`, vi.fn());
  expect(result).toMatchObject({ outcome: "completed", value: Array(6).fill("undefined") });
  expect(await runToolScript(`import fs from 'node:fs'; export default async function() {}`, vi.fn()))
    .toMatchObject({ outcome: "error", error: expect.stringContaining("imports are not allowed") });
});

it("parses and normalizes URLs with the host's URL semantics inside the isolate", async () => {
  const cases = [
    ["/author/status/123?ref=feed#details", "https://x.com/home"],
    ["https://EXAMPLE.test:443/a/../b?q=hello world"],
    ["https://münich.example/日本語"],
    ["mailto:person@example.test"],
    ["https://[::1]:8080/"],
  ];
  const result = await runToolScript(`export default function() {
    return ${JSON.stringify(cases)}.map(([input, base]) => {
      const url = new URL(input, base);
      return {href: url.href, origin: url.origin, pathname: url.pathname, host: url.host,
        search: url.search, hash: url.hash, text: String(url), json: JSON.stringify(url)};
    });
  }`, vi.fn());
  expect(result).toMatchObject({ outcome: "completed", value: cases.map(([input, base]) => {
    const url = new URL(input!, base);
    return {href: url.href, origin: url.origin, pathname: url.pathname, host: url.host,
      search: url.search, hash: url.hash, text: String(url), json: JSON.stringify(url)};
  }) });
});

it("keeps URL fields and live search parameters synchronized", async () => {
  const result = await runToolScript(`export default function() {
    const url = new URL('/author/status/123?ref=feed&tag=a&tag=b', 'https://x.com');
    const params = url.searchParams;
    params.delete('ref');
    params.append('text', 'hello + world');
    params.sort();
    const first = url.href;
    const tags = params.getAll('tag');
    url.pathname = '/new path';
    url.hash = 'details';
    url.search = '?count=2';
    params.set('count', '3');
    const second = url.href;
    url.href = 'https://example.test/?a=1&a=2';
    params.delete('a', '1');
    return {first, second, tags, href: url.href, same: params === url.searchParams,
      entries: [...params], size: params.size, present: params.has('a', '2'),
      parsed: URL.parse('/relative', 'https://example.test').href,
      invalid: URL.parse('not a URL'), valid: URL.canParse('https://example.test')};
  }`, vi.fn());
  expect(result).toMatchObject({ outcome: "completed", value: {
    first: "https://x.com/author/status/123?tag=a&tag=b&text=hello+%2B+world",
    second: "https://x.com/new%20path?count=3#details", tags: ["a", "b"],
    href: "https://example.test/?a=2", same: true, entries: [["a", "2"]], size: 1, present: true,
    parsed: "https://example.test/relative", invalid: null, valid: true,
  } });
});

it("supports standalone query parsing, iteration and encoding", async () => {
  const result = await runToolScript(`export default function() {
    const params = new URLSearchParams('?text=hello+world&escaped=%2B&tag=a&tag=b');
    const entries = [];
    params.forEach((value, key) => entries.push([key, value]));
    return {entries, keys: [...params.keys()], values: [...params.values()],
      copied: new URLSearchParams(params).toString(),
      record: new URLSearchParams({text: 'a b', plus: '+'}).toString(),
      pairs: new URLSearchParams([['tag', 1], ['tag', 2]]).toString()};
  }`, vi.fn());
  expect(result).toMatchObject({ outcome: "completed", value: {
    entries: [["text", "hello world"], ["escaped", "+"], ["tag", "a"], ["tag", "b"]],
    keys: ["text", "escaped", "tag", "tag"], values: ["hello world", "+", "a", "b"],
    copied: "text=hello+world&escaped=%2B&tag=a&tag=b", record: "text=a+b&plus=%2B", pairs: "tag=1&tag=2",
  } });
});

it("keeps URL objects and errors in the guest and bounds parser inputs", async () => {
  const result = await runToolScript(`export default function() {
    let invalid, oversized;
    try { new URL('not a URL'); } catch (error) {
      invalid = {type: error instanceof TypeError, process: error.constructor.constructor('return typeof process')()};
    }
    try { new URL('https://example.test/' + 'x'.repeat(70000)); } catch (error) { oversized = error.message; }
    return {invalid, oversized, process: URL.constructor('return typeof process')(),
      getter: Object.getOwnPropertyDescriptor(URL.prototype, 'href').get.constructor('return typeof process')(),
      objectURLs: typeof URL.createObjectURL, fetch: typeof fetch};
  }`, vi.fn());
  expect(result).toMatchObject({ outcome: "completed", value: {
    invalid: {type: true, process: "undefined"}, oversized: expect.stringContaining("65536"),
    process: "undefined", getter: "undefined", objectURLs: "undefined", fetch: "undefined",
  } });
});

it("bounds top-level and function CPU loops and unresolved promises", async () => {
  for (const source of ["while(true){}; export default async function() {}",
    "export default async function() { while(true){} }",
    "export default async function() { await new Promise(() => {}); }"]) {
    expect(await runToolScript(source, vi.fn(), { wallClockMs: 50 })).toMatchObject({ outcome: "killed" });
  }
});

it("serializes calls and drains unawaited work before declaring success", async () => {
  const order: string[] = [];
  const result = await runToolScript(`export default async function(tools) {
    tools.call('first', {}); tools.call('second', {}); return 'queued';
  }`, async (name) => {
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`${name}:end`);
    return { ok: true };
  });
  expect(result).toMatchObject({ outcome: "completed", calls: 2 });
  expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
});

it("fences queued calls on timeout and aborts the active host operation", async () => {
  const calls: string[] = [];
  const result = await runToolScript(`export default async function(tools) {
    tools.call('slow', {}); tools.call('must-not-run', {}); return null;
  }`, async (name, _args, signal) => {
    calls.push(name);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return null;
  }, { wallClockMs: 50 });
  expect(result.outcome).toBe("killed");
  expect(calls).toEqual(["slow"]);
});

it("enforces call and return-size budgets", async () => {
  const call = vi.fn(async () => null);
  const result = await runToolScript(`export default async function(tools) {
    for(let i=0; i<10; i++) { try { await tools.call('emit', {}); } catch {} }
  }`, call, { maxCalls: 2 });
  expect(result.outcome).toBe("completed");
  expect(call).toHaveBeenCalledTimes(2);
  expect(await runToolScript(`export default async function() { return 'a'.repeat(9000); }`, call))
    .toMatchObject({ outcome: "error", error: expect.stringContaining("8000") });
});

it("cancellation fences later calls even if guest catches the rejection", async () => {
  const abort = new AbortController();
  const call = vi.fn(async () => { abort.abort(); return null; });
  const result = await runToolScript(`export default async function(tools) {
    try { await tools.call('first', {}); } catch {}
    try { await tools.call('second', {}); } catch {}
  }`, call, { signal: abort.signal });
  expect(result).toMatchObject({ error: "run_cancelled" });
  expect(call).toHaveBeenCalledTimes(1);
});

it("reports oversized output separately after draining admitted writes without replaying them", async () => {
  const call = vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: true };
  });
  const result = await runToolScript(`export default async api => {
    api.call('write', {});
    return 'x'.repeat(9000);
  }`, call);
  expect(result).toMatchObject({ outcome: "error", code: "output_too_large", outputChars: 9002,
    effectsSettled: true, calls: 1, error: expect.stringContaining("not rolled back") });
  expect(call).toHaveBeenCalledTimes(1);
});

it("counts serialized JSON including escaping at the exact output boundary", async () => {
  expect(await runToolScript(`export default () => 'x'.repeat(7998)`, vi.fn()))
    .toMatchObject({ outcome: "completed" });
  expect(await runToolScript(`export default () => '\\n'.repeat(4000)`, vi.fn()))
    .toMatchObject({ outcome: "error", code: "output_too_large", outputChars: 8002 });
});

it("does not charge trusted human-control waits against code wall time", async () => {
  const result = await runToolScript(`export default async function(tools) {
    return await tools.call('observe', {});
  }`, async (_name, _args, _signal, waitForControl) => {
    await waitForControl(() => new Promise((resolve) => setTimeout(resolve, 150)));
    return { resumed: true };
  }, { wallClockMs: 75 });
  expect(result).toMatchObject({ outcome: "completed", value: { resumed: true } });
});

it("terminates a memory bomb within the isolate", async () => {
  const result = await runToolScript(`export default async function() {
    const values = []; while (true) values.push(new Array(100000).fill(7));
  }`, vi.fn(), { wallClockMs: 3000 });
  expect(result.outcome).toBe("killed");
});

it("yields bounded code cooperatively and refuses subsequent queued effects", async () => {
  const call = vi.fn(async () => ({ accepted: true }));
  const result = await runToolScript(`export default async function(tools) {
    const budget = await tools.budget();
    if (budget.remainingCalls !== 100) throw new Error('missing budget');
    await tools.call('emit', {});
    await tools.yield();
    try { await tools.call('must-not-run', {}); } catch {}
    return 'checkpointed';
  }`, call);
  expect(result).toMatchObject({ outcome: "yielded", effectsSettled: true, calls: 1 });
  expect(call).toHaveBeenCalledTimes(1);
});

it("waits for admitted effects to settle after the guest deadline", async () => {
  let committed = false;
  const result = await runToolScript(`export default async tools => await tools.call('write', {})`, async () => {
    await new Promise(resolve => setTimeout(resolve, 120));
    committed = true;
    return { ok: true };
  }, { wallClockMs: 60, settleMs: 1000 });
  expect(committed).toBe(true);
  expect(result).toMatchObject({ outcome: "killed", limit: "wall_clock", effectsSettled: true });
});

it("reports unresolved effects explicitly instead of allowing a blind retry", async () => {
  const result = await runToolScript(`export default async tools => await tools.call('write', {})`, async () => new Promise(() => {}),
    { wallClockMs: 60, settleMs: 20 });
  expect(result).toMatchObject({ outcome: "killed", effectsSettled: false });
});

it("does not confuse a cancelled guest with a settled host wait", async () => {
  const abort=new AbortController();
  let release!: () => void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  try {
    const result=await runToolScript("export default async api => api.call('write',{})",async()=>{
      setTimeout(()=>abort.abort(),10);
      await pending;
      return {ok:true};
    },{signal:abort.signal,hostWaits:true,settleMs:20});
    expect(result).toMatchObject({outcome:"killed",effectsSettled:false});
  } finally {release();}
});
