import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunSession } from "@tabductor/browser";
import { secretAccessLog } from "@tabductor/db";
import {
  createSecret,
  createSecretsBroker,
  fileKeyWrapper,
  rotateFileKek,
  zero,
  type SecretsBrokerRunDeps,
} from "@tabductor/secrets";
import { startFixtures, type Fixtures } from "@tabductor/testkit";
import { newRun, openSession, startBrowserRig, traceRows, type BrowserRig, type SessionRig } from "./browser-support.js";

/**
 * The subphase's central test suite (§16 Threat 4). The value-leak test below is
 * non-negotiable per `S5b-secrets-broker.md`: it is what proves the broker's whole reason to
 * exist rather than merely asserting its code shape.
 *
 * Two things the spec asks this suite to check that it structurally cannot yet, and why:
 * "every recorded LLM transcript" and "all captured log output" have no content to search
 * here, because wiring `secrets.fill` into the agent's tool registry (`buildToolRegistry`,
 * `packages/agent/src/tools.ts`) is S5c's job per this subphase's territory split — no LLM
 * call and no logger sit between the broker and the page in this suite yet. What *is* checked,
 * exhaustively, is every row this run's trace and access log ever hold — the surface a future
 * tool wrapper adds nothing to but a `secrets.fill` tool-call frame around.
 */

let rig: BrowserRig;
let secondFx: Fixtures;
let kekDir: string;
let sess: SessionRig | undefined;

beforeAll(async () => {
  [rig, secondFx] = await Promise.all([startBrowserRig(), startFixtures()]);
  kekDir = mkdtempSync(join(tmpdir(), "tabductor-secrets-broker-"));
});

afterEach(async () => {
  await sess?.close();
  sess = undefined;
});

afterAll(async () => {
  await Promise.all([rig?.close(), secondFx?.close()]);
  if (kekDir) rmSync(kekDir, { recursive: true, force: true });
});

let kekCounter = 0;
/** A fresh KEK file per test — rotation and unknown-ref cases must not bleed across tests. */
function newKeyWrapper() {
  return fileKeyWrapper(join(kekDir, `kek-${kekCounter++}.json`));
}

function makeBroker(keyWrapper: ReturnType<typeof newKeyWrapper>, opts: { maxFillsPerRun?: number } = {}) {
  const registered = new Map<string, SecretsBrokerRunDeps>();
  const broker = createSecretsBroker({
    db: rig.handle.db,
    keyWrapper,
    resolveRun: (runId) => registered.get(runId),
    maxFillsPerRun: opts.maxFillsPerRun,
  });
  return { broker, register: (runId: string, deps: SecretsBrokerRunDeps) => registered.set(runId, deps) };
}

async function accessLogRows(runId: string) {
  return rig.handle.db.select().from(secretAccessLog).where(eq(secretAccessLog.runId, runId));
}

const originOf = (url: string): string => new URL(url).origin;

it("fills a secret into fake-gram's login form; the server-side value is correct and the plaintext never touches the trace or the access log", async () => {
  const keyWrapper = newKeyWrapper();
  const { broker, register } = makeBroker(keyWrapper);
  const plaintext = "S5b_leak_probe_9f2e6b7c4a1d";
  await createSecret(rig.handle.db, keyWrapper, {
    userId: "user_test",
    name: "fakegram_password",
    value: plaintext,
    allowedOrigins: [originOf(rig.fx.url)],
  });

  sess = await openSession(rig);
  register(sess.runId, { session: sess.session, trace: sess.trace });
  const { page, resolveAnchor } = sess.session;

  await page.goto(`${rig.fx.url}/fake-gram`);
  const perception = await page.perceive();
  const usernameAnchor = perception.elements.find((e) => e.name === "username")?.anchor;
  const passwordAnchor = perception.elements.find((e) => e.name === "password")?.anchor;
  const submitAnchor = perception.elements.find((e) => e.tag === "button" && e.text === "Log in")?.anchor;
  expect(usernameAnchor).toBeDefined();
  expect(passwordAnchor).toBeDefined();
  expect(submitAnchor).toBeDefined();

  await page.type(resolveAnchor(usernameAnchor!)!, "leak_probe_user");
  const result = await broker.fill(sess.runId, "fakegram_password", passwordAnchor!);
  expect(result).toEqual({ ok: true });

  await page.click(resolveAnchor(submitAnchor!)!);
  await page.waitFor('[data-testid="result"]');

  // 1. The server-side submitted value is correct.
  const res = await fetch(`${rig.fx.url}/fake-gram/admin/submissions`);
  const { submissions } = (await res.json()) as { submissions: { kind: string; fields: Record<string, string> }[] };
  const login = submissions.find((s) => s.kind === "login");
  expect(login?.fields.username).toBe("leak_probe_user");
  expect(login?.fields.password).toBe(plaintext);

  // 2. Zero hits in the run's entire trace — payloads and blob refs alike.
  await sess.trace.flush();
  const rows = await traceRows(rig, sess.runId);
  expect(rows.length).toBeGreaterThan(0);
  expect(JSON.stringify(rows)).not.toContain(plaintext);

  // 3. Zero hits in secret_access_log, and the row that recorded success has no value-shaped
  // column at all — `action`/`anchor` only, matching the schema (there is no `value` column
  // to accidentally hit, but the content check is the load-bearing half of that claim).
  const logRows = await accessLogRows(sess.runId);
  expect(logRows.length).toBeGreaterThan(0);
  expect(JSON.stringify(logRows)).not.toContain(plaintext);
  const filledRow = logRows.find((r) => r.action === "filled");
  expect(filledRow).toMatchObject({ secretName: "fakegram_password", anchor: passwordAnchor });
  expect(Object.keys(filledRow!)).not.toContain("value");
});

it("refuses a fill when the page's live origin doesn't match the secret's allowed_origins, and traces policy_denied", async () => {
  const keyWrapper = newKeyWrapper();
  const { broker, register } = makeBroker(keyWrapper);
  await createSecret(rig.handle.db, keyWrapper, {
    userId: "user_test",
    name: "origin_bound_secret",
    value: "irrelevant-value",
    allowedOrigins: [originOf(rig.fx.url)], // NOT secondFx's origin
  });

  sess = await openSession(rig);
  register(sess.runId, { session: sess.session, trace: sess.trace });

  // Navigate to the *other* fixture instance — a different origin (distinct port on the same
  // host), which is exactly what origin binding must catch.
  await sess.session.page.goto(`${secondFx.url}/fake-gram`);
  const perception = await sess.session.page.perceive();
  const passwordAnchor = perception.elements.find((e) => e.name === "password")!.anchor;

  await expect(broker.fill(sess.runId, "origin_bound_secret", passwordAnchor)).rejects.toMatchObject({
    code: "secret_denied_origin",
  });

  await sess.trace.flush();
  const rows = await traceRows(rig, sess.runId);
  expect(
    rows.some(
      (r) => r.kind === "policy_denied" && (r.payloadJson as Record<string, unknown>).rule === "denied_origin",
    ),
  ).toBe(true);

  const logRows = await accessLogRows(sess.runId);
  expect(logRows.some((r) => r.action === "denied_origin")).toBe(true);
});

it("refuses a hidden field", async () => {
  const keyWrapper = newKeyWrapper();
  const { broker, register } = makeBroker(keyWrapper);
  await createSecret(rig.handle.db, keyWrapper, {
    userId: "user_test",
    name: "hidden_target_secret",
    value: "irrelevant-value",
    allowedOrigins: [originOf(rig.fx.url)],
  });

  sess = await openSession(rig);
  register(sess.runId, { session: sess.session, trace: sess.trace });

  await sess.session.page.goto(`${rig.fx.url}/fake-gram`);
  const perception = await sess.session.page.perceive();
  const hiddenAnchor = perception.elements.find((e) => e.name === "csrfHidden")?.anchor;
  expect(hiddenAnchor).toBeDefined();

  await expect(broker.fill(sess.runId, "hidden_target_secret", hiddenAnchor!)).rejects.toMatchObject({
    code: "secret_denied_target",
  });

  const logRows = await accessLogRows(sess.runId);
  expect(logRows.some((r) => r.action === "denied_target_hidden")).toBe(true);
});

it("refuses a target that only resolves inside a cross-origin iframe, with a distinct outcome from the hidden-field case", async () => {
  const keyWrapper = newKeyWrapper();
  const { broker, register } = makeBroker(keyWrapper);
  await createSecret(rig.handle.db, keyWrapper, {
    userId: "user_test",
    name: "iframe_target_secret",
    value: "irrelevant-value",
    allowedOrigins: [originOf(rig.fx.url)],
  });

  sess = await openSession(rig);
  const opened = sess;
  // A synthetic anchor resolving to a locator that exists only inside the embedded (other-
  // origin) iframe. `perceive()` never surfaces iframe content in the first place (Playwright's
  // own `page.locator()` never crosses a frame boundary on its own — see
  // `packages/browser/src/playwright-driver.ts`'s `resolveAcrossFrames`), so a real anchor
  // could never point there; this stands in for what an attacker-crafted locator would look
  // like if the broker's target validation didn't exist.
  const fakeSession: RunSession = {
    ...opened.session,
    resolveAnchor: (anchor) =>
      anchor === "attack-iframe" ? 'input[name="password"]' : opened.session.resolveAnchor(anchor),
  };
  register(opened.runId, { session: fakeSession, trace: opened.trace });

  const embeddedUrl = `${secondFx.url}/fake-gram`;
  await opened.session.page.goto(`${rig.fx.url}/iframe-wrap?src=${encodeURIComponent(embeddedUrl)}`);

  // Poll until the iframe's own document has loaded far enough for its password field to
  // resolve — test-timing synchronization only, not part of the security assertion below.
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (await fakeSession.page.probeTarget('input[name="password"]')) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(ready).toBe(true);

  await expect(broker.fill(opened.runId, "iframe_target_secret", "attack-iframe")).rejects.toMatchObject({
    code: "secret_denied_target",
  });

  const logRows = await accessLogRows(opened.runId);
  expect(logRows.some((r) => r.action === "denied_target_cross_origin_frame")).toBe(true);
});

it("fails further fills once a run exceeds its per-run rate limit", async () => {
  const keyWrapper = newKeyWrapper();
  const { broker, register } = makeBroker(keyWrapper, { maxFillsPerRun: 1 });
  await createSecret(rig.handle.db, keyWrapper, {
    userId: "user_test",
    name: "rate_limited_secret",
    value: "v",
    allowedOrigins: [originOf(rig.fx.url)],
  });

  sess = await openSession(rig);
  register(sess.runId, { session: sess.session, trace: sess.trace });

  await sess.session.page.goto(`${rig.fx.url}/fake-gram`);
  const perception = await sess.session.page.perceive();
  const passwordAnchor = perception.elements.find((e) => e.name === "password")!.anchor;

  const first = await broker.fill(sess.runId, "rate_limited_secret", passwordAnchor);
  expect(first).toEqual({ ok: true });

  await expect(broker.fill(sess.runId, "rate_limited_secret", passwordAnchor)).rejects.toMatchObject({
    code: "secret_rate_limited",
  });

  const logRows = await accessLogRows(sess.runId);
  expect(logRows.some((r) => r.action === "rate_limited")).toBe(true);
});

it("injectIntoMcpArg hands back a plaintext-free handle; redeemMcpHandle resolves it exactly once, host-side only", async () => {
  const keyWrapper = newKeyWrapper();
  const { broker } = makeBroker(keyWrapper);
  const plaintext = "mcp-arg-secret-value";
  await createSecret(rig.handle.db, keyWrapper, {
    userId: "user_test",
    name: "mcp_secret",
    value: plaintext,
    allowedOrigins: [],
  });
  const runId = await newRun(rig); // no page needed — injectIntoMcpArg never binds an origin

  const handle = await broker.injectIntoMcpArg(runId, "mcp_secret");
  expect(handle.token).toBeTruthy();
  expect(JSON.stringify(handle)).not.toContain(plaintext);

  const buf = await broker.redeemMcpHandle(handle);
  try {
    expect(buf.toString("utf8")).toBe(plaintext);
  } finally {
    zero(buf);
  }

  // Single-use: the same handle cannot be redeemed twice.
  await expect(broker.redeemMcpHandle(handle)).rejects.toMatchObject({ code: "secret_handle_invalid" });

  const logRows = await accessLogRows(runId);
  expect(logRows.some((r) => r.action === "injected")).toBe(true);
  expect(JSON.stringify(logRows)).not.toContain(plaintext);
});

it("a secret survives a KEK rotation — old ciphertext still resolves via its own stored kek_ref", async () => {
  const kekPath = join(kekDir, `kek-${kekCounter++}-rotate.json`);
  const rotatingWrapper = fileKeyWrapper(kekPath);

  const plaintext = "pre-rotation-secret-value";
  await createSecret(rig.handle.db, rotatingWrapper, {
    userId: "user_test",
    name: "rotate_secret",
    value: plaintext,
    allowedOrigins: [],
  });

  const newRef = rotateFileKek(kekPath);
  expect(newRef).toBeTruthy();

  const { broker } = makeBroker(rotatingWrapper);
  const runId = await newRun(rig);
  const handle = await broker.injectIntoMcpArg(runId, "rotate_secret");
  const buf = await broker.redeemMcpHandle(handle);
  try {
    expect(buf.toString("utf8")).toBe(plaintext);
  } finally {
    zero(buf);
  }

  const logRows = await accessLogRows(runId);
  expect(logRows.length).toBeGreaterThan(0);
  for (const row of logRows) {
    expect(Object.keys(row).some((k) => /value/i.test(k))).toBe(false);
  }
});
