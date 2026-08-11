import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { AppError } from "@tabductor/core";
import {
  openSession,
  payloadOf,
  startBrowserRig,
  waitForTrace,
  type BrowserRig,
  type SessionRig,
} from "./browser-support.js";

let rig: BrowserRig;
let sess: SessionRig | undefined;

beforeAll(async () => {
  rig = await startBrowserRig();
});

afterEach(async () => {
  await sess?.close();
  sess = undefined;
});

afterAll(async () => {
  await rig?.close();
});

it("aborts the third goto once max_visits is spent, and the trace names the limit", async () => {
  sess = await openSession(rig, { limits: { maxVisits: 2 } });
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  await page.goto(`${rig.fx.url}/fake-gram`);

  const err = await page.goto(`${rig.fx.url}/fake-tweets`).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe("resource_limit_exceeded");
  expect((err as AppError).details).toMatchObject({ limit: "max_visits" });

  const rows = await waitForTrace(rig, sess, "the max_visits breach", (r) =>
    r.some((x) => payloadOf(x).limit === "max_visits"),
  );
  const breach = rows.find((r) => payloadOf(r).limit === "max_visits")!;
  expect(breach.kind).toBe("action");
  expect(payloadOf(breach)).toMatchObject({ action: "goto", ok: false, limit: "max_visits" });
});

it("aborts a second openTab once max_tabs is spent, and the trace names the limit", async () => {
  sess = await openSession(rig, { limits: { maxTabs: 1 } });

  const first = await sess.session.openTab();
  expect(first.url()).toBe("about:blank");

  const err = await sess.session.openTab().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe("resource_limit_exceeded");
  expect((err as AppError).details).toMatchObject({ limit: "max_tabs" });

  const rows = await waitForTrace(rig, sess, "the max_tabs breach", (r) =>
    r.some((x) => payloadOf(x).limit === "max_tabs"),
  );
  const breach = rows.find((r) => payloadOf(r).limit === "max_tabs")!;
  expect(payloadOf(breach)).toMatchObject({ action: "openTab", ok: false, limit: "max_tabs" });
});

it("surfaces max_wall_ms on the action after the clock has already run out", async () => {
  sess = await openSession(rig, { limits: { maxWallMs: 150 } });
  const { page } = sess.session;

  // Slow enough to guarantee the budget is gone by the time it resolves, fast enough not to
  // make the test slow: the assertion is about the *next* action, not this one.
  await page.goto(`${rig.fx.url}/slowpoke?delay_ms=400`);

  const err = await page.goto(`${rig.fx.url}/fake-tweets`).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe("resource_limit_exceeded");
  expect((err as AppError).details).toMatchObject({ limit: "max_wall_ms" });

  const rows = await waitForTrace(rig, sess, "the max_wall_ms breach", (r) =>
    r.some((x) => payloadOf(x).limit === "max_wall_ms"),
  );
  const breach = rows.find((r) => payloadOf(r).limit === "max_wall_ms")!;
  expect(payloadOf(breach)).toMatchObject({ ok: false, limit: "max_wall_ms" });
});
