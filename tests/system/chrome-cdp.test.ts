import { afterAll, beforeAll, expect, it } from "vitest";
import { launchChrome, startFixtures, type Chrome, type Fixtures } from "@tabductor/testkit";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Minimal raw CDP client over Node's built-in WebSocket — no extra deps.
type Cdp = {
  send: <T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<T>;
  close: () => Promise<void>;
};

function connectCdp(wsUrl: string): Promise<Cdp> {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
    let nextId = 1;

    ws.addEventListener("error", () => rejectConn(new Error(`websocket error connecting to ${wsUrl}`)));
    ws.addEventListener("close", () => {
      // Fail in-flight calls instead of hanging until the test timeout.
      for (const [, entry] of pending) entry.reject(new Error("CDP socket closed"));
      pending.clear();
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) return; // event, not a reply
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`CDP error: ${msg.error.message}`));
      else entry.resolve(msg.result as never);
    });

    const cdp: Cdp = {
      send: (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve: resolve as (v: never) => void, reject });
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        }),
      close: () =>
        new Promise((resolve) => {
          ws.addEventListener("close", () => resolve());
          ws.close();
        }),
    };
    ws.addEventListener("open", () => resolveConn(cdp));
  });
}

let chrome: Chrome;
let fx: Fixtures;

beforeAll(async () => {
  [chrome, fx] = await Promise.all([launchChrome(), startFixtures()]);
});

afterAll(async () => {
  await Promise.all([chrome?.close(), fx?.close()]);
});

it("launches Chrome and speaks raw CDP: getVersion, navigate, read title", async () => {
  expect(chrome.wsUrl).toMatch(/^ws:\/\//);
  const cdp = await connectCdp(chrome.wsUrl);

  const version = await cdp.send<{ product: string; protocolVersion: string }>(
    "Browser.getVersion",
  );
  expect(version.product).toMatch(/Chrome/);
  expect(version.protocolVersion).toBeTruthy();

  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: `${fx.url}/fake-tweets`,
  });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });

  // Poll: the page may still be loading right after createTarget.
  let title = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const evaluated = await cdp.send<{ result: { value?: string } }>(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      sessionId,
    );
    title = evaluated.result.value ?? "";
    if (title !== "") break;
    await sleep(100);
  }
  expect(title).toBe("Fake Tweets");

  // The fixture renders tweets from a real XHR; prove that actually runs in the browser,
  // since later network-observation tests depend on it.
  let dom = { tweets: 0, text: null as string | null };
  const domDeadline = Date.now() + 15_000;
  while (Date.now() < domDeadline) {
    const evaluated = await cdp.send<{ result: { value?: string } }>(
      "Runtime.evaluate",
      {
        expression: `JSON.stringify({tweets: document.querySelectorAll('[data-testid="tweet"]').length, text: document.querySelector('[data-testid="tweetText"]')?.textContent ?? null})`,
        returnByValue: true,
      },
      sessionId,
    );
    dom = JSON.parse(evaluated.result.value ?? "{}");
    if (dom.tweets > 0) break;
    await sleep(100);
  }
  expect(dom.tweets).toBeGreaterThanOrEqual(3);
  expect(dom.text).toBe("first tweet");

  await cdp.send("Target.closeTarget", { targetId });
  await cdp.close();
});
