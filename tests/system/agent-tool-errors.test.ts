import { expect, it } from "vitest";
import { AppError } from "@tabductor/core";
import { buildToolRegistry } from "@tabductor/agent";
import type { RunSession } from "@tabductor/browser";

/**
 * `AgentTool.execute` is documented "Never throws" — every failure comes back as
 * `{ok:false, error}` so the loop hands it to the model and the step budget arbitrates
 * retries. That held only for failures this registry *authored* (a stale anchor, a bad emit
 * packet); a driver call underneath could still throw, and one that did ended the run.
 *
 * Seen in production against a Cloudflare interstitial: the model perceived a "Try again"
 * button, clicked it, the button went away mid-challenge, and Playwright's 15s timeout threw
 * through `loop.ts` and failed the run at step two — no recovery, and no trace worth
 * compiling. `ai` mode exists to explore a page it has not seen; a tool that crashes the run
 * on the first surprise cannot do that.
 *
 * The exception is infrastructure: a dead endpoint or an exhausted budget is not something
 * the model can react to, so those still throw and reach `mapError`.
 */

/** A session whose page methods all throw whatever the test plants. */
function sessionThrowing(err: unknown): RunSession {
  const boom = async (): Promise<never> => {
    throw err;
  };
  return {
    page: {
      goto: boom,
      click: boom,
      type: boom,
      perceive: boom,
      extract: boom,
      probeTarget: boom,
      insertTextRaw: boom,
      close: boom,
    },
    resolveAnchor: () => "css=#anchored",
  } as unknown as RunSession;
}

const registry = (session: RunSession) =>
  new Map(buildToolRegistry({ session, emit: async () => ({ outcome: "deduped" as const }) }).map((t) => [t.name, t]));

it("turns a driver timeout into a tool result instead of failing the run", async () => {
  const timeout = new Error(
    'locator.click: Timeout 15000ms exceeded.\nCall log:\n  - waiting for locator(\'button:text-is("Try again")\').first()\n',
  );
  const tools = registry(sessionThrowing(timeout));

  const result = await tools.get("page.click")!.execute({ anchor: "a1" });
  expect(result.ok).toBe(false);
  // The model is told which tool failed and why, on one line — Playwright's "Call log:" tail
  // is its own internals and only crowds the transcript the compiler later reads.
  expect(result).toMatchObject({ error: expect.stringContaining("page.click failed") });
  expect((result as { error: string }).error).toContain("Timeout 15000ms exceeded");
  expect((result as { error: string }).error).not.toContain("Call log");
});

it("recovers the same way for every page tool, not just click", async () => {
  const tools = registry(sessionThrowing(new Error("Target page, context or browser has been closed")));
  for (const name of ["page.goto", "page.perceive", "page.click"]) {
    const tool = tools.get(name);
    if (!tool) continue;
    const args = name === "page.goto" ? { url: "https://example.com" } : { anchor: "a1" };
    const result = await tool.execute(args);
    expect(result.ok, `${name} should not throw`).toBe(false);
  }
});

it("still throws for infrastructure failures the model cannot act on", async () => {
  // These four are what `mapError` turns into run outcomes. Handing "the browser you were
  // driving is gone" back as a tool result would spend the rest of the step budget re-asking
  // a dead connection.
  for (const code of [
    "browser.disconnected",
    "resource_limit_exceeded",
    "endpoint_queue_full",
    "no_endpoint_configured",
  ]) {
    const tools = registry(sessionThrowing(new AppError(code, `${code} happened`)));
    await expect(
      tools.get("page.click")!.execute({ anchor: "a1" }),
      `${code} must reach the executor`,
    ).rejects.toThrow(code);
  }
});

it("still rejects bad arguments without calling the driver at all", async () => {
  let called = false;
  const session = {
    page: {
      click: async () => {
        called = true;
      },
    },
    resolveAnchor: () => "css=#a",
  } as unknown as RunSession;
  const tools = registry(session);
  const result = await tools.get("page.click")!.execute({ nope: 1 });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("invalid arguments") });
  expect(called).toBe(false);
});
