import { describe, expect, it, vi } from "vitest";
import { createCamoufoxWorkerDriver } from "./camoufox-worker-driver.js";

describe("Camoufox worker driver", () => {
  it("authenticates and fences every command with the assigned generation", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = JSON.parse(String(init?.body)) as { method: string };
      const value = body.method === "page.create" ? { page_id: "p1" } : body.method === "page.perceive"
        ? { url: "https://example.com", title: "Example", elements: [], text: "ok" } : null;
      return new Response(JSON.stringify({ value }), { status: 200 });
    });
    const driver = createCamoufoxWorkerDriver({ token: "secret", sessionId: "sess_1", generation: 7, fetch: fetch as typeof globalThis.fetch });
    const conn = await driver.connect("http://worker:8080/");
    const page = await conn.createPage();
    expect((await page.perceive()).title).toBe("Example");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init.headers).toMatchObject({ authorization: "Bearer secret", "x-tabductor-rpc-version": "1" });
      expect(JSON.parse(String(call.init.body))).toMatchObject({ generation: 7 });
    }
  });
});

it("delivers popup-attributed observations once and fetches bodies only on demand", async () => {
  const calls: string[] = [];
  const started = { method: "GET", url: "https://fixture.test/api", resourceType: "fetch", status: null,
    timings: { startedAt: 100, endedAt: null, durationMs: null } };
  const events = [
    { sequence: 0, kind: "request", page_id: "p1", request_id: "r1", record: started },
    { sequence: 1, kind: "settled", page_id: "p1", request_id: "r1", record: { ...started, status: 200,
      timings: { startedAt: 100, endedAt: 200, durationMs: 100 } } },
    { sequence: 2, kind: "dialog", page_id: "p1", dialog: { type: "alert", message: "Browser dialog dismissed" } },
  ];
  const fetch = vi.fn(async (_url, init) => {
    const command = JSON.parse(String(init.body));
    calls.push(command.method);
    if (command.method === "page.create") return Response.json({ value: { page_id: "p1" } });
    if (command.method === "network.part") return Response.json({ value: { bytes: Buffer.from('{"fixture":true}').toString("base64"), mime: "application/json" } });
    return Response.json({ value: command.method === "page.perceive" ? { url: started.url, title: "Fixture", text: "", elements: [] } : null,
      events, event_cursor: 2 });
  });
  const conn = await createCamoufoxWorkerDriver({ token: "fixture", sessionId: "s1", generation: 1,
    fetch: fetch as typeof globalThis.fetch }).connect("http://worker:8080");
  let original: unknown;
  const onStart = vi.fn((record) => { original = record; });
  const onSettled = vi.fn(async (record, parts) => {
    expect(record).toBe(original);
    expect(record.status).toBe(200);
    expect(calls).not.toContain("network.part");
    expect(JSON.parse((await parts.responseBody()).bytes.toString())).toEqual({ fixture: true });
  });
  const onDialog = vi.fn();
  try {
    const page = await conn.createPage({ network: { onStart, onSettled }, onDialog });
    await page.goto("https://fixture.test");
    await page.perceive(); // The server repeats the same feed; hooks must not repeat.
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onDialog).toHaveBeenCalledTimes(1);
    expect(calls.filter((method) => method === "network.part")).toHaveLength(1);
  } finally { await conn.close(); }
});
