import { expect, it } from "vitest";
import { AppError } from "@tabductor/core";
import { CDP_ENDPOINT_UNREACHABLE, resolveCdpWsUrl } from "@tabductor/browser";

/**
 * `resolveCdpWsUrl` — the reason an endpoint is stored as `http://host:port` rather than as
 * the `ws://` URL Playwright ultimately needs.
 *
 * Two failures motivated it, both seen in the wild. Chrome regenerates the DevTools GUID on
 * every restart, so a stored `ws://` URL names a target that stops existing the moment the
 * user quits their browser. And the URL is 76 characters of hand-copied hex: clipping the
 * last one yields something that passes every validation worth writing and then answers 404.
 * Resolving from `/json/version` on each connect removes both.
 */

const versionBody = (ws: string): string => JSON.stringify({ Browser: "Chrome/151", webSocketDebuggerUrl: ws });

/** A `fetch` that answers one URL and records what it was asked for. */
function stubFetch(handler: (url: string) => { status?: number; body: string }): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const { status = 200, body } = handler(url);
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

it("passes a ws:// URL through untouched", async () => {
  const ws = "ws://127.0.0.1:9222/devtools/browser/09d58c86-6bb5-444e-ad0f-c24355b12bac";
  const { fetch, calls } = stubFetch(() => ({ body: "{}" }));
  expect(await resolveCdpWsUrl(ws, fetch)).toBe(ws);
  // Nothing to discover — an endpoint already naming its target must not need the network.
  expect(calls).toEqual([]);
});

it("resolves an http:// base through /json/version", async () => {
  const { fetch, calls } = stubFetch(() => ({
    body: versionBody("ws://192.168.1.22:9223/devtools/browser/09d58c86-6bb5-444e-ad0f-c24355b12bac"),
  }));
  const out = await resolveCdpWsUrl("http://192.168.1.22:9223", fetch);
  expect(calls).toEqual(["http://192.168.1.22:9223/json/version"]);
  expect(out).toBe("ws://192.168.1.22:9223/devtools/browser/09d58c86-6bb5-444e-ad0f-c24355b12bac");
});

it("accepts a pasted /json/version URL without doubling the path", async () => {
  // The URL people actually have on the clipboard is the one the docs tell them to curl.
  const { fetch, calls } = stubFetch(() => ({ body: versionBody("ws://h:9223/devtools/browser/abc") }));
  await resolveCdpWsUrl("http://h:9223/json/version", fetch);
  expect(calls).toEqual(["http://h:9223/json/version"]);
});

it("keeps the address we reached and takes only the GUID path from the browser", async () => {
  // The original bug: Chrome bound to host loopback reports itself as 127.0.0.1:9222, which
  // means *the container* to an engine reading it. The address that just answered is better
  // evidence than the one the browser guesses about itself.
  const { fetch } = stubFetch(() => ({
    body: versionBody("ws://127.0.0.1:9222/devtools/browser/09d58c86-6bb5-444e-ad0f-c24355b12bac"),
  }));
  const out = await resolveCdpWsUrl("http://192.168.1.22:9223", fetch);
  expect(out).toBe("ws://192.168.1.22:9223/devtools/browser/09d58c86-6bb5-444e-ad0f-c24355b12bac");
});

it("uses wss:// when the base is https://", async () => {
  const { fetch } = stubFetch(() => ({ body: versionBody("ws://internal:9222/devtools/browser/abc") }));
  expect(await resolveCdpWsUrl("https://proxy.example:443", fetch)).toBe(
    "wss://proxy.example/devtools/browser/abc",
  );
});

it("reports a typed error when the browser is not listening", async () => {
  const impl = (async () => {
    throw new Error("fetch failed: ECONNREFUSED");
  }) as unknown as typeof fetch;
  const err = await resolveCdpWsUrl("http://192.168.1.22:9223", impl).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(CDP_ENDPOINT_UNREACHABLE);
  // The cause has to survive: a generic failure here is what made the original outage take a
  // network probe to diagnose instead of a log line.
  expect((err as AppError).message).toContain("ECONNREFUSED");
});

it("reports a typed error for a non-200 and for a response with no debugger URL", async () => {
  const notFound = stubFetch(() => ({ status: 404, body: "nope" }));
  const a = await resolveCdpWsUrl("http://h:9223", notFound.fetch).catch((e: unknown) => e);
  expect((a as AppError).code).toBe(CDP_ENDPOINT_UNREACHABLE);
  expect((a as AppError).message).toContain("HTTP 404");

  // A browser started without `--remote-debugging-port` answers, but without the field.
  const noField = stubFetch(() => ({ body: JSON.stringify({ Browser: "Chrome/151" }) }));
  const b = await resolveCdpWsUrl("http://h:9223", noField.fetch).catch((e: unknown) => e);
  expect((b as AppError).code).toBe(CDP_ENDPOINT_UNREACHABLE);
  expect((b as AppError).message).toContain("webSocketDebuggerUrl");
});

it("rejects a scheme that is neither http nor ws", async () => {
  const err = await resolveCdpWsUrl("ftp://h:9223", undefined).catch((e: unknown) => e);
  expect((err as AppError).code).toBe(CDP_ENDPOINT_UNREACHABLE);
});
