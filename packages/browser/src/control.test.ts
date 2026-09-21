import { expect, it, vi } from "vitest";
import { AppError } from "@tabductor/core";
import { withAutomationControl } from "./control.js";
import { createCamoufoxWorkerDriver } from "./camoufox-worker-driver.js";
import type { BrowserConn } from "./driver.js";

it("waits for control during initialization and retries only ownership rejections", async () => {
  const wait = vi.fn(async () => true);
  const conn = { waitForAutomation: wait } as unknown as BrowserConn;
  const version = vi.fn().mockRejectedValueOnce(new AppError("browser_input_revoked", "paused")).mockResolvedValue("worker");
  expect(await withAutomationControl(conn, version)).toBe("worker");
  expect(wait).toHaveBeenCalledTimes(2);
  const uncertain = vi.fn().mockRejectedValue(new AppError("browser_timeout", "uncertain"));
  await expect(withAutomationControl(conn, uncertain)).rejects.toMatchObject({ code: "browser_timeout" });
  expect(uncertain).toHaveBeenCalledTimes(1);
});

it.each([
  [409, "browser_input_revoked", false], [409, "browser_stale_target", false],
  [422, "browser_target_obstructed", false], [408, "browser_timeout", false],
  [500, "browser_command_failed", false], [503, "browser.disconnected", true],
])("preserves typed worker errors without disconnecting for action errors (%s, %s)", async (status, code, dead) => {
  const conn = await createCamoufoxWorkerDriver({ sessionId: "s", token: "test", generation: 1,
    fetch: vi.fn(async () => new Response(JSON.stringify({ detail: { code, message: "Inspect the page", outcomeUncertain: true } }), { status })),
  }).connect("http://worker");
  const disconnected = vi.fn(); conn.onDisconnect!(disconnected);
  await expect(conn.version()).rejects.toMatchObject({ code, details: { outcomeUncertain: true } });
  expect(disconnected).toHaveBeenCalledTimes(dead ? 1 : 0);
  await conn.close();
});

it("does not classify an engine ownership rejection as a transport disconnect", async () => {
  const conn = await createCamoufoxWorkerDriver({ sessionId: "s", token: "test", generation: 1,
    fetch: async () => { throw new AppError("browser_input_revoked", "paused"); },
  }).connect("http://worker");
  const disconnected = vi.fn(); conn.onDisconnect!(disconnected);
  await expect(conn.version()).rejects.toMatchObject({ code: "browser_input_revoked" });
  expect(disconnected).not.toHaveBeenCalled();
  await conn.close();
});
