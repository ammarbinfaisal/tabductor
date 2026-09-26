import { expect, it, vi } from "vitest";
import { AppError } from "@tabductor/core";
import { buildBrowserCodeTools } from "./tools.js";
import { pythonFixture, testRunner } from "./python-test-support.js";

function fixture() {
  const { session } = pythonFixture();
  const screenshot = vi.fn(async () => Buffer.from("png"));
  session.page.screenshot = screenshot;
  const pythonRunner = vi.fn(testRunner());
  const beforeCall = vi.fn<() => Promise<unknown>>(async () => undefined);
  const tools = buildBrowserCodeTools({ session, pythonRunner, beforeCall, emit: async () => ({ outcome: "deduped" }) });
  return { tool: tools.find(t => t.name === "browser.screenshot")!, screenshot, pythonRunner, beforeCall };
}

it("attaches a viewport or selector crop without starting Python", async () => {
  const f = fixture();
  expect(await f.tool.execute({})).toEqual({ ok: true, value: { mime: "image/png", bytes: 3 }, images: [{ data: "cG5n", mime: "image/png" }] });
  expect(f.screenshot).toHaveBeenLastCalledWith(undefined);
  await f.tool.execute({ selector: "main" });
  expect(f.screenshot).toHaveBeenLastCalledWith({ selector: "main" });
  expect(f.pythonRunner).not.toHaveBeenCalled();
});

it("bounds images and returns recoverable screenshot failures", async () => {
  const f = fixture();
  f.screenshot.mockResolvedValueOnce(Buffer.alloc(1_000_001));
  expect(await f.tool.execute({})).toMatchObject({ ok: false, error: expect.stringContaining("crop") });
  f.screenshot.mockRejectedValueOnce(new AppError("browser_stale_target", "Target changed"));
  expect(await f.tool.execute({ selector: "main" })).toMatchObject({ ok: false, code: "browser_stale_target" });
});

it("honors control changes, cancellation and terminal browser errors", async () => {
  const f = fixture();
  f.beforeCall.mockResolvedValueOnce({ url: "https://fresh.test" });
  expect(await f.tool.execute({})).toMatchObject({ ok: false, value: { url: "https://fresh.test" } });
  expect(f.screenshot).not.toHaveBeenCalled();
  await expect(f.tool.execute({}, AbortSignal.abort())).rejects.toThrow();
  expect(f.screenshot).not.toHaveBeenCalled();
  f.screenshot.mockRejectedValueOnce(new AppError("browser_input_revoked", "Control changed"));
  await expect(f.tool.execute({})).rejects.toMatchObject({ code: "browser_input_revoked" });
});
