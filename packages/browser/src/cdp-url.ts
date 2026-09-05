import { AppError } from "@tabductor/core";

/**
 * Turning what a user can paste into the `ws://` URL Playwright needs.
 *
 * A browser's DevTools websocket URL carries a GUID that Chrome regenerates on **every
 * restart** — so a stored `ws://…/devtools/browser/<guid>` is a credential with an
 * unannounced expiry, and the endpoint it names dies silently the next time the user quits
 * their browser. It is also 76 characters of hand-copied hex, which is its own failure mode:
 * one truncated character produces a URL that is still well-formed, still passes every
 * validation worth writing, and answers `404` at connect time.
 *
 * So the durable thing to store is the browser's **HTTP address** — `http://host:port` — and
 * the durable time to resolve is *every connect*. `/json/version` is the discovery endpoint
 * Chrome has always exposed for exactly this, and asking it each time means a restarted
 * browser is picked up rather than mourned.
 *
 * `ws://` is still accepted and passed through untouched, for an endpoint added before this
 * existed and for anything fronting CDP that has no `/json/version` to ask.
 */

export const CDP_ENDPOINT_UNREACHABLE = "cdp_endpoint_unreachable";

/** How long `/json/version` gets to answer. Short: this runs on the connect path, and an
 * endpoint that cannot answer a local HTTP GET promptly is not one a run should wait on. */
const DISCOVERY_TIMEOUT_MS = 5_000;

const unreachable = (url: string, reason: string, cause?: unknown): AppError =>
  new AppError(CDP_ENDPOINT_UNREACHABLE, `could not resolve a CDP websocket URL from ${url}: ${reason}`, {
    ...(cause === undefined ? {} : { cause }),
    details: { url, reason },
  });

/**
 * Accepts what a user might paste and returns the base to probe.
 *
 * `/json/version` is tolerated on the end because it is the URL people actually have in
 * hand — it is what the docs tell them to curl, so it is what lands on the clipboard. Any
 * other path is kept: a reverse proxy may well mount the browser under one.
 */
function discoveryUrl(raw: URL): string {
  const path = raw.pathname.replace(/\/+$/, "");
  const base = path.endsWith("/json/version") ? path.slice(0, -"/json/version".length) : path;
  return new URL(`${base}/json/version`, raw.origin).href;
}

/**
 * Chrome fills `webSocketDebuggerUrl`'s host from the request's `Host` header, so it usually
 * echoes back however it was addressed — but not always, and "usually" is what produced the
 * original bug this whole path exists to prevent: a browser reached over the network at
 * `192.168.1.22:9223` reporting itself as `127.0.0.1:9222`, an address that means the
 * *container* to the engine reading it. The GUID is the only part of that response we could
 * not have known; the address we just successfully reached is better evidence than the one
 * the browser guesses about itself. So keep the path, and keep our own host and port.
 */
function rehost(reported: string, base: URL): string {
  const ws = new URL(reported);
  const out = new URL(base.href);
  out.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  out.pathname = ws.pathname;
  out.search = ws.search;
  return out.href;
}

/**
 * `ws://`/`wss://` passes through; `http://`/`https://` is resolved through `/json/version`.
 *
 * `fetchImpl` is injected for the tests, which have no browser to ask — the same shape the
 * rest of this package uses for its driver and blob store.
 */
export async function resolveCdpWsUrl(
  endpointUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw unreachable(endpointUrl, "not a URL");
  }

  if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return endpointUrl;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw unreachable(endpointUrl, `unsupported scheme "${parsed.protocol}"`);
  }

  const probe = discoveryUrl(parsed);
  let res: Response;
  try {
    res = await fetchImpl(probe, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      // The response is a fact about the browser right now; a cached one would reinstate the
      // stale-GUID problem this function exists to remove.
      cache: "no-store",
      redirect: "follow",
    });
  } catch (err) {
    throw unreachable(probe, err instanceof Error ? err.message : String(err), err);
  }

  if (!res.ok) throw unreachable(probe, `HTTP ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw unreachable(probe, "response was not JSON", err);
  }

  const reported =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).webSocketDebuggerUrl
      : undefined;
  if (typeof reported !== "string" || reported.length === 0) {
    // A browser started without `--remote-debugging-port` answers this endpoint but omits the
    // field, so say which part was missing rather than "unreachable".
    throw unreachable(probe, "response had no webSocketDebuggerUrl");
  }

  try {
    return rehost(reported, parsed);
  } catch (err) {
    throw unreachable(probe, `webSocketDebuggerUrl was not a URL: ${reported}`, err);
  }
}
