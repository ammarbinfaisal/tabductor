import { describe, expect, it, vi } from "vitest";
import { createCamoufoxWorkerDriver } from "./camoufox-worker-driver.js";

it.each([
  { detail: { code: "browser_invocation_expired", message: "Start a fresh cell", outcomeUncertain: false }, code: "browser_invocation_expired", uncertain: false },
  { detail: { code: "browser_invocation_expired", message: "Inspect prior effects", outcomeUncertain: true }, code: "browser_invocation_expired", uncertain: true },
  { detail: { code: "browser_outcome_uncertain", message: "Already submitted", outcomeUncertain: true }, code: "browser_outcome_uncertain", uncertain: true },
  { detail: "expired or foreign invocation", code: "browser_command_failed", uncertain: true },
  { detail: "input ownership was revoked", code: "browser_input_revoked", uncertain: true },
])("preserves proxy error classification: $code ($uncertain)", async ({ detail, code, uncertain }) => {
  const fetch = vi.fn(async (_url, init) => {
    const command = JSON.parse(String(init.body));
    return command.method === "page.create" ? Response.json({ value: { page_id: "root" } })
      : Response.json({ detail }, { status: 409 });
  });
  const conn = await createCamoufoxWorkerDriver({ token: "fixture", sessionId: "s", generation: 1, fetch: fetch as typeof globalThis.fetch }).connect("http://worker");
  try {
    const page = await conn.createPage();
    await expect(page.proxy!({ command: "open" }, { invocation: "cell" })).rejects.toMatchObject({ code, details: { outcomeUncertain: uncertain, status: 409 } });
  } finally { await conn.close(); }
});

it("preserves cancelled operation uncertainty without resubmitting it", async () => {
  let starts = 0;
  const fetch = vi.fn(async (_url, init) => {
    const command = JSON.parse(String(init.body));
    if (command.method === "page.create") return Response.json({ value: { page_id: "root" } });
    if (command.method === "start") { starts++; return Response.json({ value: { ticket: "job" } }); }
    return Response.json({ value: { pending: false, events: [], result: { ok: false, code: "browser_operation_cancelled", error: "Inspect effects", outcomeUncertain: true } } });
  });
  const conn = await createCamoufoxWorkerDriver({ token: "fixture", sessionId: "s", generation: 1, fetch: fetch as typeof globalThis.fetch }).connect("http://worker");
  try {
    const page = await conn.createPage();
    await expect(page.proxy!({ command: "call", call: { target: { id: "page", class: "Page", scope: "cell" }, member: "click", args: ["button"], kwargs: {} } }, { invocation: "cell" }))
      .rejects.toMatchObject({ code: "browser_operation_cancelled", details: { outcomeUncertain: true } });
    expect(starts).toBe(1);
  } finally { await conn.close(); }
});

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

it("lists and switches tabs through the original root after a selected popup closes", async () => {
  const calls: Array<{method:string;page_id?:string;params:Record<string,string>}> = [];
  const fetch = vi.fn(async (_url, init) => {
    const command = JSON.parse(String(init.body));
    calls.push(command);
    if (command.method === "tab.acquire") return Response.json({value:{page_id:"root",url:"https://destination.test"}});
    if (command.method === "page.perceive" && command.page_id === "popup") return Response.json({detail:{
      code:"browser_page_closed",message:"Popup closed; list tabs",outcomeUncertain:true,
    }}, {status:409});
    if (["page.tabs", "page.switch_tab"].includes(command.method)) {
      expect(command.page_id).toBe("root");
      return Response.json({value:command.method === "page.tabs" ? [{id:"root",url:"https://destination.test",title:"Signed in"}]
        : {page_id:command.params.id,url:"https://destination.test"}});
    }
    return Response.json({value:"alive"});
  });
  const conn = await createCamoufoxWorkerDriver({token:"test",sessionId:"s",generation:1,tabKey:"destination",fetch:fetch as typeof globalThis.fetch}).connect("http://worker");
  const disconnected = vi.fn();
  conn.onDisconnect!(disconnected);
  try {
    const root = await conn.createPage();
    const popup = await root.switchTab!("popup");
    await expect(popup.perceive()).rejects.toMatchObject({code:"browser_page_closed"});
    expect(await popup.tabs!()).toEqual([{id:"root",url:"https://destination.test",title:"Signed in"}]);
    const destination = await popup.switchTab!("root");
    expect(await destination.title()).toBe("alive");
    expect(disconnected).not.toHaveBeenCalled();
    expect(calls.filter(c=>c.method === "page.perceive")[0]?.page_id).toBe("popup");
  } finally { await conn.close(); }
});
