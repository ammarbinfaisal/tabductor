import { AppError } from "@tabductor/core";
import {
  chromium,
  type Frame,
  type Page as PwPage,
  type Request as PwRequest,
  type Route,
} from "playwright-core";
import type {
  BrowserConn,
  CreatePageOptions,
  Driver,
  ExtractedRecord,
  ExtractSpec,
  NavigationHook,
  NetworkHooks,
  NetworkRecord,
  Page,
} from "./driver.js";
import type { NavCause } from "@tabductor/policy";

/**
 * The only file in the codebase that imports Playwright. Everything it returns is a plain
 * object shaped by `driver.ts`, so replacing this file is the whole cost of replacing
 * Playwright (§20).
 *
 * Connection model: `connectOverCDP` against a user's endpoint, driving their **default
 * browser context** — not a fresh one. That is the product: the value of BYO-CDP is the
 * session the user is already logged into, and `newContext()` would throw it away.
 *
 * ## How the navigation guard is built, and why it is not one mechanism
 *
 * Neither of Playwright's two interception points covers every navigation on its own, and
 * both gaps were found by probing this browser rather than by reading the docs:
 *
 * 1. **`context.route` never fires again for a redirect hop.** `route.continue()` hands the
 *    request back to Chromium, which follows a `302` internally; the handler sees the first
 *    URL and nothing else. A guard built only on it lets `/redirect?to=evil` straight past.
 * 2. **A popup's first request has no frame.** `request.frame()` *throws* — the request is
 *    issued before the page exists — so a CDP session cannot be attached in time, and
 *    Playwright emits the `page` event only after that navigation commits, so waiting for
 *    it inside the handler deadlocks on the request the handler is holding.
 *
 * So a raw CDP `Fetch` session per page is the guard — it sees every document request,
 * redirect hops included — and the route layer's job is to convert the one request CDP
 * cannot see in time into one it can: a popup's birth is answered with an inert stub served
 * at the requested URL (no network touched), the born page gets its guard and is attributed
 * to its opener, and the navigation is then re-issued for real — so the *actual* redirect
 * chain is checked hop by hop, not a probe's approximation of it. For a page whose guard is
 * live the route layer continues untouched, so exactly one layer decides any given request.
 *
 * Two structural costs, named rather than buried. `context.route` is context-wide and the
 * context is the user's own, so while a connection is live every request in every tab they
 * have open detours through our handler — continued untouched, but the latency is theirs;
 * that is the price of BYO-CDP plus popup coverage. And a popup that cannot be attributed
 * to an opener answers to *every* hook this connection holds, because `noopener` severs
 * attribution on purpose and severed must not mean unguarded.
 */

// The page-side extraction callback runs in the browser, where these globals exist. The
// workspace does not load TypeScript's DOM lib (this is a Node package), so the two shapes
// the callback touches are declared here rather than pulling in `lib.dom` for one function.
type DomNode = {
  textContent: string | null;
  getAttribute: (name: string) => string | null;
  querySelector: (sel: string) => DomNode | null;
};
declare const document: { querySelectorAll: (sel: string) => ArrayLike<DomNode> };

/** The slice of `Fetch.requestPaused` this file uses. */
type RequestPaused = {
  requestId: string;
  request: { url: string };
  /** Present only when this request is a hop of a redirect chain — the case §16 cares about. */
  redirectedRequestId?: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/** What a popup is born holding instead of its real document; see `routeGuard`. */
const BIRTH_STUB = "<!doctype html><title></title>";

export const playwrightDriver: Driver = { connect };

/** A fragment never reaches the network, so URLs are compared without one. */
const stripFragment = (url: string): string => url.split("#", 1)[0]!;

async function connect(wsUrl: string): Promise<BrowserConn> {
  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());

  /** Which guard applies to which page. A popup inherits its opener's — see `adoptNewPage`. */
  const hooks = new Map<PwPage, NavigationHook>();
  /** Guard attachments, in flight or done, so two racing adoptions share one CDP session. */
  const guards = new Map<PwPage, Promise<void>>();
  /** Pages whose `Fetch.enable` has resolved — the route layer defers to these. */
  const guarded = new Set<PwPage>();
  /** Pages this connection opened (plus popups they spawned) — the only ones we may close. */
  const ourPages = new Set<PwPage>();
  /** The URL a `goto` is currently waiting on, so the guard can call that navigation initial. */
  const pendingGoto = new Map<PwPage, string>();
  /** URLs answered with a birth stub, each waiting for its popup to appear. */
  const pendingBirths: string[] = [];
  /** Stub-born popups that have not yet committed a real document. */
  const birthing = new Map<PwPage, string>();
  /**
   * Set when a navigation is refused, read by `goto` to turn Chromium's generic
   * `ERR_BLOCKED_BY_CLIENT` into a typed error. A popup's opening navigation has no caller
   * awaiting it — its denial reaches the world through the hook, which is why the hook
   * records rather than only answering.
   */
  const denials = new Map<PwPage, { url: string; cause: NavCause }>();
  let routed = false;

  /** Which page's traffic goes where (S3b). A popup inherits its opener's, same as `hooks`. */
  const netHooks = new Map<PwPage, NetworkHooks>();

  /**
   * The hook an unattributable page answers to: every hook this connection holds must
   * allow. `window.open(url, "", "noopener")` severs the opener on purpose, and a guard
   * that treated severed as unowned would make `noopener` the way out. With several pages
   * open, each hook also records the navigation it is asked about — the price of refusing
   * to guess whose popup it is.
   */
  const everyHook = (): NavigationHook | undefined => {
    const all = [...hooks.values()];
    if (all.length <= 1) return all[0];
    return async (req) => {
      for (const hook of all) if (!(await hook(req))) return false;
      return true;
    };
  };

  const classify = (page: PwPage, url: string, redirect: boolean): NavCause => {
    if (redirect) return "redirect";
    if (birthing.get(page) === url) return "window_open";
    return pendingGoto.get(page) === url ? "initial" : "script";
  };

  /**
   * The guard proper: one CDP `Fetch` session per page, filtered to documents so no
   * subresource pays for the round trip. The hook is looked up per request rather than
   * captured, so a page adopted twice in a race answers to whichever hook won.
   */
  const attachGuard = (page: PwPage): Promise<void> => {
    const existing = guards.get(page);
    if (existing) return existing;
    const attaching = (async () => {
      const cdp = await context.newCDPSession(page);
      cdp.on("Fetch.requestPaused", (raw) => {
        const event = raw as unknown as RequestPaused;
        void (async () => {
          const url = event.request.url;
          const cause = classify(page, url, event.redirectedRequestId !== undefined);
          const hook = hooks.get(page);
          // No hook means the page is mid-close and its bookkeeping is already gone.
          const allowed = hook ? await hook({ url, cause }).catch(() => false) : true;
          if (!allowed) denials.set(page, { url, cause });
          await cdp
            .send(
              allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
              allowed
                ? { requestId: event.requestId }
                : { requestId: event.requestId, errorReason: "BlockedByClient" },
            )
            // The page can go away mid-flight; a dead session is not a failed guard.
            .catch(() => undefined);
          // A popup denied before any real document has committed is a window showing
          // nothing but our birth stub; closing it is the abort the stub deferred.
          if (!allowed && birthing.has(page)) {
            birthing.delete(page);
            await page.close().catch(() => undefined);
          }
        })();
      });
      await cdp.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
      });
      guarded.add(page);
    })();
    guards.set(page, attaching);
    return attaching;
  };

  /**
   * The network observer (S3b §9 step 1). Playwright's page-level `request`/`response`
   * events, not raw CDP `Network.*`: unlike the navigation guard, nothing here needs to
   * intercept or delay a request, so there is no gap for CDP to close — and a redirect's hops
   * are each their own `request`/`response` pair with `request.redirectedFrom()` linking
   * them, which is everything §9 step 1 asks a normalized record to carry. CDP stays the
   * fallback the S3b doc names, for if Playwright's view of some traffic (service workers,
   * cross-process navigations) proves lossy in practice.
   *
   * One request, two events here: `request` fires with method/url/resourceType known and
   * `status: null`, `response`/`requestfailed` fires once more against the *same* record
   * object, filled in. A `WeakMap` keyed by Playwright's own `Request` is what connects the
   * two — nothing about it survives past this function, which is the whole point of driver.ts
   * (§20): the caller never sees a `Request` or a `Response`, only the normalized record and a
   * body-fetching closure.
   */
  const attachNetwork = (page: PwPage, hooks: NetworkHooks): void => {
    const pending = new WeakMap<PwRequest, NetworkRecord>();

    page.on("request", (req) => {
      const record: NetworkRecord = {
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        status: null,
        timings: { startedAt: Date.now(), endedAt: null, durationMs: null },
      };
      pending.set(req, record);
      // Fire-and-forget: nothing here can wait on `hooks.onStart` without stalling the page's
      // own event loop, so a rejected trace write (session's implementation, not this file's
      // problem) is swallowed rather than surfaced as an unhandled rejection.
      Promise.resolve(hooks.onStart?.(record)).catch(() => undefined);
    });

    page.on("response", (res) => {
      const req = res.request();
      const record = pending.get(req);
      // No record means `response` fired for a request from before this listener attached
      // (a service-worker-served response can do this) — nothing to complete.
      if (!record) return;
      record.status = res.status();
      record.timings.endedAt = Date.now();
      record.timings.durationMs = record.timings.endedAt - record.timings.startedAt;
      Promise.resolve(
        hooks.onSettled?.(record, async () => ({
          bytes: await res.body(),
          mime: res.headers()["content-type"] ?? "application/octet-stream",
        })),
      ).catch(() => undefined);
    });

    page.on("requestfailed", (req) => {
      const record = pending.get(req);
      if (!record) return;
      record.timings.endedAt = Date.now();
      record.timings.durationMs = record.timings.endedAt - record.timings.startedAt;
      Promise.resolve(
        hooks.onSettled?.(record, () =>
          Promise.reject(
            new AppError("network_body_unavailable", `request to ${record.url} failed, no response body`, {
              details: { url: record.url },
            }),
          ),
        ),
      ).catch(() => undefined);
    });
  };

  const adopt = async (page: PwPage, hook: NavigationHook, net?: NetworkHooks): Promise<void> => {
    hooks.set(page, hook);
    ourPages.add(page);
    if (net) {
      netHooks.set(page, net);
      attachNetwork(page, net);
    }
    page.once("close", () => {
      hooks.delete(page);
      guards.delete(page);
      guarded.delete(page);
      ourPages.delete(page);
      pendingGoto.delete(page);
      birthing.delete(page);
      denials.delete(page);
      netHooks.delete(page);
    });
    await attachGuard(page);
  };

  /**
   * The route layer. For a page that exists it is only a stopgap — once `Fetch.enable` has
   * resolved, the CDP guard decides everything and this handler continues those requests
   * untouched. Its real job is the one navigation CDP can never see in time: the request
   * that creates a popup, for which no page exists to attach a session to. That request is
   * answered with an inert stub at the requested URL, which births the popup instantly and
   * without touching the network; `adoptNewPage` then attaches the guard and re-issues the
   * navigation for real.
   */
  const routeGuard = async (route: Route): Promise<void> => {
    const req = route.request();
    if (!req.isNavigationRequest()) return route.continue();

    // Throws when the frame does not exist yet, which *is* the popup-birth signal.
    let page: PwPage | null = null;
    try {
      page = req.frame().page();
    } catch {
      page = null;
    }

    if (page) {
      if (guarded.has(page)) return route.continue();
      // No hook resolves for a tab of the user's that we did not open. We are a guest in
      // this browser; policing their own tabs is not our business.
      const hook = hooks.get(page);
      if (!hook) return route.continue();
      // Ours, but the CDP guard is still attaching — decide here so the page is never
      // unguarded for an instant. A redirect this hop grows mid-flight is the one thing
      // this path cannot see; that residual race is the raw-CDP auto-attach design's to
      // close (see the S3b note in the subphase doc), not this layer's.
      const url = req.url();
      const cause = classify(page, url, req.redirectedFrom() !== null);
      if (await hook({ url, cause })) return route.continue();
      denials.set(page, { url, cause });
      return route.abort("blockedbyclient");
    }

    if (hooks.size === 0) return route.continue();
    // A POST into a window that does not exist yet cannot be reborn from a stub without
    // dropping its body, and cannot be guarded in flight — and a cross-window POST of
    // arbitrary data is precisely the exfil shape §16 exists for. Refusing is the only
    // answer a guard is allowed to give to "I don't know".
    if (req.method() !== "GET") return route.abort("blockedbyclient");
    pendingBirths.push(req.url());
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      // `no-store` so the re-issued navigation below must hit the network, where the
      // guard is.
      headers: { "cache-control": "no-store" },
      body: BIRTH_STUB,
    });
  };

  /**
   * Every page the context reports that `createPage` did not make — popups above all. A
   * popup is attributed to its opener and inherits that page's hook; an unattributable one
   * (`noopener`, an opener already gone, a tab opened from the browser's own UI) answers to
   * `everyHook` rather than to nobody. A popup attributed to a tab of the user's is left
   * alone — except that if we answered its birth with a stub, we still owe it its real
   * navigation.
   */
  const adoptNewPage = async (page: PwPage): Promise<void> => {
    const birthIdx = pendingBirths.indexOf(stripFragment(page.url()));
    const stubbed = birthIdx !== -1;
    if (stubbed) pendingBirths.splice(birthIdx, 1);

    const opener = await page.opener().catch(() => null);
    const hook = opener ? hooks.get(opener) : everyHook();
    // No `everyHook`-style fallback for network: an unattributable popup is not part of any
    // session's page tree, so it is not this session's traffic to observe — only a security
    // guard has to answer for a page it cannot identify, an observer does not.
    const net = opener ? netHooks.get(opener) : undefined;
    if (hook && !hooks.has(page)) await adopt(page, hook, net);

    if (!stubbed) return;
    if (hook) {
      birthing.set(page, stripFragment(page.url()));
      // Birth ends when a real document commits; until then a denial closes the popup.
      const committed = (frame: Frame): void => {
        if (frame !== page.mainFrame()) return;
        birthing.delete(page);
        page.off("framenavigated", committed);
      };
      page.on("framenavigated", committed);
    }
    // The stub's job ends the moment the guard is live: re-issue the navigation for real.
    // `reload` rather than `location.replace(location.href)` because a fragment in the URL
    // would make the latter a same-document hop that never touches the network. The
    // evaluate can die with the context it runs in; the navigation it started survives.
    await page.evaluate("location.reload()").catch(() => undefined);
  };

  const ensureRouted = async (): Promise<void> => {
    if (routed) return;
    routed = true;
    context.on("page", (page) => void adoptNewPage(page).catch(() => undefined));
    await context.route("**/*", (route) => {
      void routeGuard(route).catch(async () => {
        // A guard that throws must not wedge the request forever, and must not fail open.
        await route.abort("failed").catch(() => undefined);
      });
    });
  };

  const wrap = (pwPage: PwPage): Page => ({
    async goto(url) {
      denials.delete(pwPage);
      pendingGoto.set(pwPage, new URL(url).href);
      try {
        await pwPage.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
      } catch (err) {
        const denial = denials.get(pwPage);
        if (denial) {
          throw new AppError("navigation_denied", `navigation to ${denial.url} was denied`, {
            cause: err,
            details: { url: denial.url, cause: denial.cause },
          });
        }
        throw err;
      } finally {
        pendingGoto.delete(pwPage);
      }
    },

    async click(selector) {
      await pwPage.locator(selector).first().click({ timeout: DEFAULT_TIMEOUT_MS });
    },

    async type(selector, text) {
      await pwPage.locator(selector).first().fill(text, { timeout: DEFAULT_TIMEOUT_MS });
    },

    async waitFor(selector, opts) {
      await pwPage.waitForSelector(selector, {
        state: "attached",
        timeout: opts?.timeout ?? DEFAULT_TIMEOUT_MS,
      });
    },

    queryAll: (selector, fields) => extract(pwPage, selector, fields),

    screenshot: () => pwPage.screenshot({ type: "png" }),

    title: () => pwPage.title(),

    url: () => pwPage.url(),

    close: () => pwPage.close(),
  });

  return {
    async createPage(opts: CreatePageOptions = {}) {
      const pwPage = await context.newPage();
      if (opts.onNavigationRequest) {
        await ensureRouted();
        await adopt(pwPage, opts.onNavigationRequest, opts.network);
      } else {
        // Network observation piggybacks on the navigation guard's adoption path — a session
        // always supplies both (`session.ts`), and a page with no guard has no owner to
        // attribute popups to either, so there is nothing sound to wire up here.
        ourPages.add(pwPage);
      }
      return wrap(pwPage);
    },

    version: async () => browser.version(),

    // S3b's pool sole extra hook (see driver.ts): Playwright's own disconnect signal,
    // out of band from the health-loop ping.
    onDisconnect: (cb) => browser.on("disconnected", cb),

    /**
     * Closes what we opened, then drops the connection. For a CDP-attached browser this
     * detaches rather than terminating the process — which is the required behaviour, since
     * the process is the user's own browser and we are borrowing it.
     */
    async close() {
      await Promise.all([...ourPages].map((p) => p.close().catch(() => undefined)));
      ourPages.clear();
      hooks.clear();
      guards.clear();
      guarded.clear();
      birthing.clear();
      await browser.close();
    },
  };
}

async function extract(
  pwPage: PwPage,
  selector: string,
  fields: ExtractSpec,
): Promise<ExtractedRecord[]> {
  return pwPage.evaluate(
    ({ root, spec }: { root: string; spec: [string, { selector?: string; attr?: string }][] }) => {
      const out: Record<string, string | null>[] = [];
      const nodes = document.querySelectorAll(root);
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i]!;
        const record: Record<string, string | null> = {};
        for (const [name, field] of spec) {
          const target = field.selector ? el.querySelector(field.selector) : el;
          if (!target) {
            record[name] = null;
            continue;
          }
          record[name] = field.attr
            ? target.getAttribute(field.attr)
            : (target.textContent ?? "").trim();
        }
        out.push(record);
      }
      return out;
    },
    // Entries rather than the object itself: the argument crosses into the page as JSON, and
    // an entry list keeps field order stable, which keeps extracted records diffable.
    { root: selector, spec: Object.entries(fields) },
  );
}
