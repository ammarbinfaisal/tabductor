import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { runCompiledScript } from "@tabductor/static-rt";
import { openSession, startBrowserRig, type BrowserRig, type SessionRig } from "./browser-support.js";
import { memoryState, recordingEmit, script } from "./static-rt-support.js";

/**
 * The cage wired to a real browser: the §11-shaped fixture script against `fake-tweets`, the
 * proof that `ctx.page.*` calls reach the traced browser session, and the dialog hook.
 */

const FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "scripts", "tweets.js"),
  "utf8",
);

let rig: BrowserRig;
let sess: SessionRig | undefined;

beforeAll(async () => {
  rig = await startBrowserRig();
}, 120_000);

afterAll(async () => {
  await rig?.close();
});

afterEach(async () => {
  await sess?.close();
  sess = undefined;
});

it("runs the §11-shaped fixture script end to end and emits what it extracted", async () => {
  sess = await openSession(rig);
  await sess.session.page.goto(`${rig.fx.url}/fake-tweets`);

  const emit = recordingEmit();
  const state = memoryState();
  const result = await runCompiledScript(FIXTURE, { session: sess.session, emit, state });

  expect(result).toEqual({ outcome: "completed" });
  expect(emit.calls.length).toBeGreaterThan(0);
  for (const call of emit.calls) {
    expect(call.type).toBe("tweet.detected");
    // The dedupe key is the permalink — what makes a re-run idempotent once S6c wires a real
    // claim behind `emitIfNew`.
    expect(call.dedupeKey).toMatch(/\/status\//);
    expect((call.packet as { text: string }).text).toBeTruthy();
  }
  // `ctx.state` really wrote through to the injected store, which is what S6c backs with
  // `task_state`.
  expect(state.all().seen).toBe(emit.calls.length);
}, 120_000);

it("a ctx.page.goto proceeds without a navigation policy check", async () => {
  sess = await openSession(rig);
  const state = memoryState();

  const result = await runCompiledScript(
    script(`
  try {
    await ctx.page.goto(${JSON.stringify(`${rig.fx.url}/fake-tweets`)});
    await ctx.state.set("outcome", "allowed");
  } catch (e) {
    await ctx.state.set("outcome", "denied:" + String(e.message));
  }`),
    { session: sess.session, emit: recordingEmit(), state },
  );

  expect(result.outcome).toBe("completed");
  expect(state.all().outcome).toBe("allowed");
  expect(sess.session.page.url()).toContain("/fake-tweets");
}, 120_000);

it("guard.all reports which checks failed, and the script deopts with them as evidence", async () => {
  sess = await openSession(rig);
  // A page the fixture script was not compiled for: `article` is absent, so the guard block
  // fails and the template's deopt path is what runs.
  await sess.session.page.goto(`${rig.fx.url}/slowpoke?delay_ms=0`);

  const result = await runCompiledScript(FIXTURE, {
    session: sess.session,
    emit: recordingEmit(),
    state: memoryState(),
  });

  expect(result.outcome).toBe("deopt");
  const deopt = result as { prompt: string; evidence: { failed: { check: string }[] } };
  expect(deopt.prompt).toContain("Timeline layout not recognized");
  // Real detail, not just "something failed" — this is what S6c hands the agent.
  expect(deopt.evidence.failed.map((f) => f.check)).toContain("exists");
}, 120_000);

it("ctx.guard.noDialog is false on a page that put up a modal, true on one that did not", async () => {
  sess = await openSession(rig);
  const quiet = memoryState();
  await sess.session.page.goto(`${rig.fx.url}/fake-tweets`);
  await runCompiledScript(
    script(`  await ctx.state.set("noDialog", await ctx.guard.noDialog());`),
    { session: sess.session, emit: recordingEmit(), state: quiet },
  );
  expect(quiet.all().noDialog).toBe(true);

  // Same session: the latch is per-session, so a modal anywhere in the run counts.
  const noisy = memoryState();
  await sess.session.page.goto(`${rig.fx.url}/dialog`);
  await runCompiledScript(
    script(`  await ctx.state.set("noDialog", await ctx.guard.noDialog());`),
    { session: sess.session, emit: recordingEmit(), state: noisy },
  );
  expect(noisy.all().noDialog).toBe(false);
}, 120_000);
