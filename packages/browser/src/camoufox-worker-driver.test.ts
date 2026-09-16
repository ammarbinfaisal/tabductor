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
