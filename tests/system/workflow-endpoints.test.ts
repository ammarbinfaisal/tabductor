import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, newId } from "@tabductor/core";
import { cdpEndpoints } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  addWorkflowEndpoint,
  getEngineStatus,
  pickWorkflowEndpoint,
  recordEngineBoot,
  staticSchemaGenerator,
  touchEngineHeartbeat,
  type RunHandle,
} from "@tabductor/engine";
import { createAgentExecutor } from "@tabductor/agent";
import { eq } from "drizzle-orm";
import { createCaller } from "../../apps/web/src/server/router.js";

/**
 * U3a: per-workflow CDP endpoints with rotation, the engine-status row, and the executors'
 * run-time endpoint resolution. The API surface is exercised through `createCaller`, same
 * as `web-api.test.ts` — these procedures are the contract the Settings page renders.
 */

let handle: MigratedTestDb;
let api: ReturnType<typeof createCaller>;
let workflowId: string;

beforeAll(async () => {
  handle = await createMigratedTestDb();
  api = createCaller({ db: handle.db, pool: handle.pool, schemaGenerator: staticSchemaGenerator({}) });
  workflowId = await api.workflow.create({ name: "endpoints under test" });
});

afterAll(async () => {
  await handle?.close();
});

describe("the endpoint router (workflow settings)", () => {
  it("adds, lists in order, reorders, and removes — with ws_url nowhere in any result", async () => {
    const a = await api.endpoint.add({ workflowId, wsUrl: "ws://127.0.0.1:9301/devtools/browser/tok-a", label: "a" });
    const b = await api.endpoint.add({ workflowId, wsUrl: "ws://127.0.0.1:9302/devtools/browser/tok-b", label: "b" });
    const c = await api.endpoint.add({ workflowId, wsUrl: "ws://127.0.0.1:9303/devtools/browser/tok-c" });

    const list = await api.endpoint.listForWorkflow({ workflowId });
    expect(list.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(list.map((e) => e.position)).toEqual([0, 1, 2]);

    // Threat 5, same assertion style as web-api.test.ts: absent from the serialization, not
    // merely untyped.
    const serialized = JSON.stringify([a, b, c, list]);
    expect(serialized).not.toContain("ws://");
    expect(serialized).not.toContain("wsUrl");
    expect(serialized).not.toContain("tok-a");

    const reordered = await api.endpoint.reorder({ workflowId, ids: [c.id, a.id, b.id] });
    expect(reordered.map((e) => e.id)).toEqual([c.id, a.id, b.id]);

    expect(await api.endpoint.remove({ workflowId, id: b.id })).toEqual({ removed: true });
    expect(await api.endpoint.remove({ workflowId, id: b.id })).toEqual({ removed: false });
    expect((await api.endpoint.listForWorkflow({ workflowId })).map((e) => e.id)).toEqual([c.id, a.id]);

    // Clean slate for the rotation tests below.
    await handle.db.delete(cdpEndpoints).where(eq(cdpEndpoints.workflowId, workflowId));
  });

  it("accepts an http:// browser address, which is the form to prefer", async () => {
    // The DevTools GUID rotates on every browser restart, so an `http://host:port` address is
    // the durable thing to store — `resolveCdpWsUrl` re-discovers the ws:// URL per connect.
    const e = await api.endpoint.add({ workflowId, wsUrl: "http://127.0.0.1:9222", label: "http form" });
    expect(e.label).toBe("http form");
    expect(JSON.stringify(e)).not.toContain("127.0.0.1");
    await api.endpoint.remove({ workflowId, id: e.id });
  });

  it("rejects a URL that is neither an http nor a ws address", async () => {
    await expect(api.endpoint.add({ workflowId, wsUrl: "ftp://127.0.0.1:9222" })).rejects.toThrow(
      /HTTP address/,
    );
    await expect(api.endpoint.add({ workflowId, wsUrl: "127.0.0.1:9222" })).rejects.toThrow(/HTTP address/);
  });

  it("edits an endpoint in place, keeping its id and its place in the rotation", async () => {
    const a = await api.endpoint.add({ workflowId, wsUrl: "http://127.0.0.1:9401", label: "first" });
    const b = await api.endpoint.add({ workflowId, wsUrl: "http://127.0.0.1:9402", label: "second" });

    const edited = await api.endpoint.update({ workflowId, id: a.id, wsUrl: "http://127.0.0.1:9999", label: "fixed" });
    expect(edited.id).toBe(a.id);
    expect(edited.label).toBe("fixed");
    // The list order *is* the rotation order — an edit that appended would silently demote
    // the endpoint the user was repairing.
    expect(edited.position).toBe(a.position);
    expect((await api.endpoint.listForWorkflow({ workflowId })).map((e) => e.id)).toEqual([a.id, b.id]);

    // The new address is stored, and still never comes back out (Threat 5).
    const [row] = await handle.db.select().from(cdpEndpoints).where(eq(cdpEndpoints.id, a.id));
    expect(row?.wsUrl).toBe("http://127.0.0.1:9999");
    expect(JSON.stringify(edited)).not.toContain("9999");

    // Label-only edit leaves the address alone — the UI cannot pre-fill a write-only field,
    // so "left blank" has to mean "keep what is there".
    await api.endpoint.update({ workflowId, id: a.id, label: "relabelled" });
    const [again] = await handle.db.select().from(cdpEndpoints).where(eq(cdpEndpoints.id, a.id));
    expect(again?.wsUrl).toBe("http://127.0.0.1:9999");
    expect(again?.label).toBe("relabelled");

    await handle.db.delete(cdpEndpoints).where(eq(cdpEndpoints.workflowId, workflowId));
  });

  it("clears unhealthy when the address is edited, and rejects an unknown endpoint", async () => {
    const e = await api.endpoint.add({ workflowId, wsUrl: "http://127.0.0.1:9403" });
    await handle.db.update(cdpEndpoints).set({ healthy: false }).where(eq(cdpEndpoints.id, e.id));

    // The old verdict was about an address that is no longer stored; leaving it would keep a
    // just-repaired endpoint looking broken until something happened to reconnect it.
    const edited = await api.endpoint.update({ workflowId, id: e.id, wsUrl: "http://127.0.0.1:9404" });
    expect(edited.healthy).toBe(true);

    await expect(
      api.endpoint.update({ workflowId, id: newId("cdp"), wsUrl: "http://127.0.0.1:9405" }),
    ).rejects.toThrow(/endpoint/);

    await handle.db.delete(cdpEndpoints).where(eq(cdpEndpoints.workflowId, workflowId));
  });

  it("rejects an unknown workflow", async () => {
    await expect(api.endpoint.add({ workflowId: "wf_nope", wsUrl: "ws://x/devtools" })).rejects.toThrow(
      /no workflow/,
    );
  });
});

describe("pickWorkflowEndpoint — the rotation", () => {
  it("rotates least-recently-acquired first, position breaking the never-used tie", async () => {
    const e1 = await addWorkflowEndpoint(handle.db, { workflowId, wsUrl: "ws://h1/devtools", label: "one" });
    const e2 = await addWorkflowEndpoint(handle.db, { workflowId, wsUrl: "ws://h2/devtools", label: "two" });
    const e3 = await addWorkflowEndpoint(handle.db, { workflowId, wsUrl: "ws://h3/devtools", label: "three" });

    const first = await pickWorkflowEndpoint(handle.db, workflowId);
    const second = await pickWorkflowEndpoint(handle.db, workflowId);
    const third = await pickWorkflowEndpoint(handle.db, workflowId);
    expect([first, second, third]).toEqual([e1.id, e2.id, e3.id]);

    // The wheel comes around: the next pick is the one acquired longest ago.
    expect(await pickWorkflowEndpoint(handle.db, workflowId)).toBe(e1.id);
  });

  it("hands concurrent picks distinct endpoints", async () => {
    const picks = await Promise.all([
      pickWorkflowEndpoint(handle.db, workflowId),
      pickWorkflowEndpoint(handle.db, workflowId),
      pickWorkflowEndpoint(handle.db, workflowId),
    ]);
    expect(new Set(picks).size).toBe(3);
  });

  it("skips unhealthy endpoints", async () => {
    const list = await api.endpoint.listForWorkflow({ workflowId });
    const [sickA, sickB] = [list[0]!, list[1]!];
    await handle.db.update(cdpEndpoints).set({ healthy: false }).where(eq(cdpEndpoints.id, sickA.id));
    await handle.db.update(cdpEndpoints).set({ healthy: false }).where(eq(cdpEndpoints.id, sickB.id));
    const survivor = list[2]!.id;
    expect(await pickWorkflowEndpoint(handle.db, workflowId)).toBe(survivor);
    expect(await pickWorkflowEndpoint(handle.db, workflowId)).toBe(survivor);
    await handle.db.update(cdpEndpoints).set({ healthy: true }).where(eq(cdpEndpoints.workflowId, workflowId));
  });

  it("throws no_endpoint_configured for a workflow with none", async () => {
    const bare = await api.workflow.create({ name: "no endpoints" });
    await expect(pickWorkflowEndpoint(handle.db, bare)).rejects.toMatchObject({ code: "no_endpoint_configured" });
  });
});

describe("the agent executor fails no_endpoint_configured permanently", () => {
  it("maps the AppError before ever touching pool, browser or model", async () => {
    const executor = createAgentExecutor({
      // Never reached: endpointFor throws first. Typed as the real deps, satisfied minimally.
      pool: { acquire: () => Promise.reject(new Error("unreachable")), close: () => Promise.resolve() },
      gate: { } as never,
      blobs: {} as never,
      db: handle.db,
      endpointFor: () =>
        Promise.reject(new AppError("no_endpoint_configured", "this workflow has no healthy browser endpoint configured")),
      llmFor: () => {
        throw new Error("unreachable");
      },
    });
    const handleStub = {
      run: { id: newId("run") },
      task: { id: newId("task") },
      trigger: null,
      emit: () => Promise.reject(new Error("unreachable")),
      declaredEmits: () => Promise.resolve([]),
    } as unknown as RunHandle;

    const result = await executor.execute(handleStub);
    expect(result).toEqual({ ok: false, error: "no_endpoint_configured", permanent: true });
  });
});

describe("engine status (U3a)", () => {
  it("reports what boot recorded and goes stale when the heartbeat stops", async () => {
    await recordEngineBoot(handle.db, ["browser:stub", "asset:stub", "browser:ai"]);
    const fresh = await getEngineStatus(handle.db);
    expect(fresh.executors).toEqual(["browser:stub", "asset:stub", "browser:ai"]);
    expect(fresh.stale).toBe(false);

    // Staleness is a pure time comparison — probe it by asking from the future.
    const future = new Date(Date.now() + 60_000);
    expect((await getEngineStatus(handle.db, future)).stale).toBe(true);

    await touchEngineHeartbeat(handle.db);
    expect((await getEngineStatus(handle.db)).stale).toBe(false);

    // A re-boot replaces the executor list — the row describes the current process only.
    await recordEngineBoot(handle.db, ["browser:stub"], ["python.run"]);
    const status = await api.engine.status();
    expect(status.executors).toEqual(["browser:stub"]);
    // S6d: tool-level abilities ride beside the executors — what an asset node can do.
    expect(status.capabilities).toEqual(["python.run"]);
  });

  it("answers 'never reported' as stale with no executors", async () => {
    const fresh = await createMigratedTestDb();
    try {
      expect(await getEngineStatus(fresh.db)).toEqual({
        executors: [],
        capabilities: [],
        bootedAt: null,
        heartbeatAt: null,
        stale: true,
      });
    } finally {
      await fresh.close();
    }
  });
});

describe("the mcp router (settings)", () => {
  it("creates a parseable server, lists without config, and removes", async () => {
    const created = await api.mcp.create({
      label: "echo",
      transport: "stdio",
      configJson: { command: "node", args: ["echo-server.js"] },
    });
    expect(created).toMatchObject({ label: "echo", transport: "stdio", secretName: null });

    const list = await api.mcp.list();
    expect(list.map((s) => s.label)).toContain("echo");
    // The row's config never rides out through the list — nothing for the UI to do with it.
    expect(JSON.stringify(list)).not.toContain("echo-server.js");

    expect(await api.mcp.remove({ id: created.id })).toEqual({ removed: true });
    expect((await api.mcp.list()).map((s) => s.label)).not.toContain("echo");
  });

  it("rejects a config the client could not load later", async () => {
    await expect(
      api.mcp.create({ label: "broken", transport: "http", configJson: { nope: true } }),
    ).rejects.toThrow(/invalid http mcp config/);
    await expect(
      api.mcp.create({ label: "broken2", transport: "stdio", configJson: {} }),
    ).rejects.toThrow(/invalid stdio mcp config/);
  });
});
