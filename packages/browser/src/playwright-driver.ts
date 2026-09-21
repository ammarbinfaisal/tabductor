import { PERCEPTION_SCRIPT } from "./perception-source.js";
import { AppError } from "@tabductor/core";
import {
  chromium,
  type Frame,
  type ElementHandle,
  type Locator,
  type Page as PwPage,
  type Request as PwRequest,
  type Route,
} from "playwright-core";
import type {
  AnchoredElement,
  BrowserConn,
  CreatePageOptions,
  DialogHook,
  Driver,
  ExtractedRecord,
  ExtractSpec,
  LocatorStrategy,
  NavigationHook,
  NetworkBody,
  NetworkHooks,
  NetworkRecord,
  Page,
  Perception,
  PerceiveOptions,
  TargetProbe,
} from "./driver.js";
import type { NavCause } from "@tabductor/core";

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

// The page-side callbacks (`extract`, `perceive`) run in the browser, where these globals
// exist. The workspace does not load TypeScript's DOM lib (this is a Node package), so the
// shapes they touch are declared here rather than pulling in `lib.dom` for two functions.
type DomNode = {
  tagName: string;
  textContent: string | null;
  getAttribute: (name: string) => string | null;
  querySelector: (sel: string) => DomNode | null;
  querySelectorAll: (sel: string) => ArrayLike<DomNode>;
  parentElement: DomNode | null;
  children: ArrayLike<DomNode>;
  getClientRects: () => { length: number };
};
declare function getComputedStyle(node: DomNode): { visibility: string; display: string };
declare const document: {
  querySelectorAll: (sel: string) => ArrayLike<DomNode>;
  title: string;
  body: { innerText: string };
};
declare const location: { href: string };

/** The slice of `Fetch.requestPaused` this file uses. */
type RequestPaused = {
  requestId: string;
  request: { url: string };
  /** Present only when this request is a hop of a redirect chain — the case §16 cares about. */
  redirectedRequestId?: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Resolves `selector` against the page's own frame tree for `probeTarget`/`insertTextRaw`
 * (S5b) — main frame first, then children in `page.frames()` order. Playwright's own
 * `page.locator()` never crosses into an iframe on its own (only `frame.locator()`, called on
 * that specific frame, does), so checking each frame explicitly is what makes a same-origin
 * iframe field reachable at all while still being able to name *which* frame matched — a
 * plain `page.locator()` could never distinguish "found in the main frame" from "found nowhere"
 * for a selector that only exists inside a child frame.
 *
 * Ambiguous is refused, not guessed: a frame where `selector` matches more than one element,
 * or a selector matching in more than one frame, returns `null` — the secrets broker treats
 * `null` the same as "not found" (`S5b-secrets-broker.md`: target validation gives no
 * selector the benefit of the doubt).
 */
async function resolveAcrossFrames(
  pwPage: PwPage,
  selector: string,
): Promise<{ locator: Locator; frame: Frame } | null> {
  if (selector.startsWith("@frame:")) {
    const target = frameTarget(pwPage, selector); const locator = target.frame.locator(target.selector);
    return await locator.count() === 1 ? { locator, frame: target.frame } : null;
  }
  const candidates: { locator: Locator; frame: Frame }[] = [];
  for (const frame of pwPage.frames()) {
    const loc = frame.locator(selector);
    const count = await loc.count();
    if (count === 1) candidates.push({ locator: loc.first(), frame });
    else if (count > 1) return null;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

/** In-page shape `probeTarget`'s `evaluate` reads off the matched element — attributes only,
 * never a value. */
type ProbedAttrs = { tag: string; type: string | null; contentEditable: boolean };

/** What a popup is born holding instead of its real document; see `routeGuard`. */
const BIRTH_STUB = "<!doctype html><title></title>";

export const playwrightDriver: Driver = { connect };

/** A fragment never reaches the network, so URLs are compared without one. */
const stripFragment = (url: string): string => url.split("#", 1)[0]!;

/**
 * Defines the `__name` helper esbuild expects, inside the page.
 *
 * The engine runs under `tsx` (`docker-compose.yml`), which transpiles with esbuild and
 * hardcodes `keepNames: true`. That rewrites every *named* function — including named inner
 * `const fn = () => …` — into `__name(fn, "fn")`, and defines `__name` once at **module**
 * scope. A function handed to `page.evaluate` is serialized with `toString()` and evaluated
 * in the page, where that module scope does not exist: the call arrives referencing a helper
 * that never travelled with it, and throws `ReferenceError: __name is not defined`.
 *
 * `perceiveInPage` is the only page function shaped to trip this (named, with named inner
 * helpers) — the driver's other two `evaluate` calls pass a plain string and an anonymous
 * arrow, and esbuild leaves both alone, an anonymous function having no name to keep.
 *
 * Installed rather than worked around because the alternatives do not survive the compiler:
 * inner `function` declarations are wrapped just the same, and a local `__name` shim is
 * renamed to `__name2` while the injected calls still resolve to module scope. The identity
 * function is the right body — the page has no use for a correct `.name`, only for the call
 * not to throw. `??=` so a page that already defines one keeps it.
 *
 * This arrow is itself name-wrapped, harmlessly: that wrap executes in Node, where the helper
 * exists, and only the *body* below is serialized into the page.
 */
const KEEP_NAMES_SHIM = (): void => {
  (globalThis as unknown as Record<string, unknown>).__name ??= (target: unknown) => target;
};

async function connect(wsUrl: string): Promise<BrowserConn> {
  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());

  // Before any page exists, so every page this connection goes on to create — and every
  // popup the context spawns — is born with the helper, and keeps it across navigations.
  // Pages the context already held predate this; `perceive` covers those.
  await context.addInitScript(KEEP_NAMES_SHIM);

  /** Which guard applies to which page. A popup inherits its opener's — see `adoptNewPage`. */
  const hooks = new Map<PwPage, NavigationHook>();
  /** Guard attachments, in flight or done, so two racing adoptions share one CDP session. */
  const guards = new Map<PwPage, Promise<void>>();
  /** Pages whose `Fetch.enable` has resolved — the route layer defers to these. */
  const guarded = new Set<PwPage>();
  /** Pages this connection opened (plus popups they spawned) — the only ones we may close. */
  const ourPages = new Set<PwPage>();
  const pageIds = new WeakMap<PwPage, string>();
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

  /** Which page's dialogs go where (S6a). Same popup inheritance as `netHooks`. */
  const dialogHooks = new Map<PwPage, DialogHook>();
  const dialogPolicies = new Map<PwPage, { accept: boolean; promptText?: string }>();
  const ownedTabs = async (root: PwPage): Promise<PwPage[]> => {
    // Keep the original root while switching among its descendants.
    while (await root.opener() && ourPages.has((await root.opener())!)) root = (await root.opener())!;
    const result: PwPage[] = [];
    for (const page of ourPages) {
      if (page.isClosed()) continue;
      let ancestor: PwPage | null = page;
      while (ancestor && ancestor !== root) ancestor = await ancestor.opener();
      if (ancestor === root) result.push(page);
    }
    return result;
  };

  /**
   * Playwright dismisses dialogs itself when nothing is listening; registering a listener
   * makes that *our* job, so the dismissal is explicit here. Behaviour is therefore unchanged
   * for every existing caller — the only difference is that the fact becomes observable.
   */
  const attachDialog = (page: PwPage, hook: DialogHook): void => {
    page.on("dialog", (dialog) => {
      hook({ type: dialog.type(), message: dialog.message() });
      const policy = dialogPolicies.get(page);
      dialogPolicies.delete(page);
      void (policy?.accept ? dialog.accept(policy.promptText) : dialog.dismiss()).catch(() => undefined);
    });
  };

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
      const target = await cdp.send("Target.getTargetInfo");
      pageIds.set(page, target.targetInfo.targetId);
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

    // A GET (or any request Chromium sent with no body) has nothing for `postDataBuffer` to
    // return — `null` there is "no body", not "not read yet", so it maps straight through.
    const requestBodyOf = async (req: PwRequest): Promise<NetworkBody | null> => {
      const data = req.postDataBuffer();
      if (!data) return null;
      return { bytes: data, mime: req.headers()["content-type"] ?? "application/octet-stream" };
    };

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

    page.on("requestfinished", (req) => {
      void (async () => {
      const res = await req.response();
      if (!res) return;
      const record = pending.get(req);
      // No record means `response` fired for a request from before this listener attached
      // (a service-worker-served response can do this) — nothing to complete.
      if (!record) return;
      record.status = res.status();
      record.timings.endedAt = Date.now();
      record.timings.durationMs = record.timings.endedAt - record.timings.startedAt;
      await Promise.resolve(
        hooks.onSettled?.(record, {
          requestHeaders: () => req.allHeaders(),
          requestBody: () => requestBodyOf(req),
          responseHeaders: () => res.allHeaders(),
          responseBody: async () => ({
            bytes: await res.body(),
            mime: res.headers()["content-type"] ?? "application/octet-stream",
          }),
        }),
      ).catch(() => undefined);
      })().catch(() => undefined);
    });

    page.on("requestfailed", (req) => {
      const record = pending.get(req);
      if (!record) return;
      record.timings.endedAt = Date.now();
      record.timings.durationMs = record.timings.endedAt - record.timings.startedAt;
      // Request-side accessors still answer for a failed request (the request itself went
      // out); only the response half has nothing to read, ever.
      const noResponse = <T>(): Promise<T> =>
        Promise.reject(
          new AppError("network_body_unavailable", `request to ${record.url} failed, no response body`, {
            details: { url: record.url },
          }),
        );
      Promise.resolve(
        hooks.onSettled?.(record, {
          requestHeaders: () => req.allHeaders(),
          requestBody: () => requestBodyOf(req),
          responseHeaders: noResponse,
          responseBody: noResponse,
        }),
      ).catch(() => undefined);
    });
  };

  const adopt = async (
    page: PwPage,
    hook: NavigationHook,
    net?: NetworkHooks,
    dialog?: DialogHook,
  ): Promise<void> => {
    hooks.set(page, hook);
    ourPages.add(page);
    if (net) {
      netHooks.set(page, net);
      attachNetwork(page, net);
    }
    if (dialog) {
      dialogHooks.set(page, dialog);
      attachDialog(page, dialog);
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
      dialogHooks.delete(page);
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
    // Same attribution as `net`: a popup inherits its opener's dialog hook, and an
    // unattributable page has no session to report a dialog to.
    const dialog = opener ? dialogHooks.get(opener) : undefined;
    if (hook && !hooks.has(page)) await adopt(page, hook, net, dialog);

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
    id: pageIds.get(pwPage),
    async goto(url, opts) {
      denials.delete(pwPage);
      pendingGoto.set(pwPage, new URL(url).href);
      try {
        await pwPage.goto(url, { waitUntil: opts?.waitUntil ?? "domcontentloaded", timeout: opts?.timeout ?? DEFAULT_TIMEOUT_MS });
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
      await withTarget(pwPage, selector, target => target.click({ timeout: 5000 }));
    },

    async type(selector, text) {
      await withTarget(pwPage, selector, target => target.fill(text, { timeout: 5000 }));
    },

    async waitFor(selector, opts) {
      await locatorOf(pwPage, selector).first().waitFor({
        state: opts?.state ?? "attached",
        timeout: opts?.timeout ?? DEFAULT_TIMEOUT_MS,
      });
    },

    async waitForLoadState(state, opts) {
      await pwPage.waitForLoadState(state, { timeout: opts?.timeout ?? DEFAULT_TIMEOUT_MS });
    },

    async probeTarget(selector): Promise<TargetProbe | null> {
      const hit = await resolveAcrossFrames(pwPage, selector);
      if (!hit) return null;
      const attrs = await hit.locator.evaluate(
        (el: { tagName: string; getAttribute: (name: string) => string | null }): ProbedAttrs => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type")?.toLowerCase() ?? null,
          contentEditable: (() => {
            const v = el.getAttribute("contenteditable");
            return v === "true" || v === "";
          })(),
        }),
      );
      return { ...attrs, frameOrigin: new URL(hit.frame.url()).origin };
    },

    async insertTextRaw(selector, text) {
      const hit = await resolveAcrossFrames(pwPage, selector);
      if (!hit) {
        throw new AppError("secrets_target_unresolved", `no unambiguous target for "${selector}"`);
      }
      await withTarget(pwPage, selector, target => target.fill(text, { timeout: 5000 }));
    },

    queryAll: (selector, fields, opts) => extract(pwPage, selector, fields, opts),

    perceive: (opts) => perceive(pwPage, opts),

    // `setInputFiles({name, mimeType, buffer})` — Playwright's own in-memory upload path, no
    // temp file created or cleaned up by this driver (S5f deliverable 1).
    async upload(selector, file) {
      await withTarget(pwPage, selector, target => target.setInputFiles(
          { name: file.name, mimeType: file.mimeType, buffer: file.bytes },
          { timeout: DEFAULT_TIMEOUT_MS },
        ));
    },

    async scroll(direction) {
      await pwPage.keyboard.press(direction === "down" ? "PageDown" : "PageUp");
    },

    async screenshot(opts) {
      if (!opts?.selector) return pwPage.screenshot({ type: "png" });
      const target = locatorOf(pwPage, opts.selector);
      const bounds = await target.boundingBox();
      if (!bounds || bounds.width * bounds.height > 4_194_304) throw new Error("element crop is absent or too large; choose a smaller visible element");
      return withTarget(pwPage, opts.selector, node => node.screenshot({ type: "png" }));
    },
    async interact(action) {
      if (action.kind === "press") {
        if (action.selector) await withTarget(pwPage, action.selector, target => target.press(action.key));
        else await pwPage.keyboard.press(action.key);
      } else if (action.kind === "select") await withTarget(pwPage, action.selector, target => target.selectOption(action.values));
      else if (action.kind === "hover") await withTarget(pwPage, action.selector, target => target.hover());
      else if (action.kind === "drag") await withTarget(pwPage, action.selector, source => withTarget(pwPage, action.target, async target => {
        await source.hover(); await pwPage.mouse.down();
        try { await target.hover(); } finally { await pwPage.mouse.up(); }
      }));
      else if (action.kind === "dialog") dialogPolicies.set(pwPage, { accept: action.accept, promptText: action.promptText });
      else if (action.kind === "scroll") {
        if (action.selector) await withTarget(pwPage, action.selector, target => (target as Locator).evaluate((el, direction) => {
          const node = el as unknown as { scrollBy: (x: number, y: number) => void; clientHeight: number; clientWidth: number };
          node.scrollBy(direction === "left" ? -node.clientWidth : direction === "right" ? node.clientWidth : 0,
            direction === "up" ? -node.clientHeight : direction === "down" ? node.clientHeight : 0);
        }, action.direction));
        else await pwPage.keyboard.press({ up: "PageUp", down: "PageDown", left: "ArrowLeft", right: "ArrowRight" }[action.direction]);
      }
    },
    async download(selector) {
      const pending = pwPage.waitForEvent("download", { timeout: DEFAULT_TIMEOUT_MS });
      // Both promises are observed even if the click fails.
      const [download] = await Promise.all([pending, withTarget(pwPage, selector, target => target.click())]);
      const stream = await download.createReadStream();
      const chunks: Buffer[] = []; let size = 0;
      try { for await (const part of stream) { size += part.length; if (size > 1_000_000) throw new Error("download exceeds 1 MB"); chunks.push(Buffer.from(part)); } }
      finally { stream.destroy(); await download.delete(); }
      return { name: download.suggestedFilename(), mime: "application/octet-stream", bytes: Buffer.concat(chunks) };
    },
    async tabs() {
      const owned = await ownedTabs(pwPage);
      return Promise.all(owned.map(async p => ({id: pageIds.get(p)!, url: p.url(), title: await p.title()})));
    },
    async switchTab(id) {
      const page = (await ownedTabs(pwPage)).find(p => pageIds.get(p) === id);
      if (!page) throw new Error("tab is not owned by this run");
      await page.bringToFront(); return wrap(page);
    },

    title: () => pwPage.title(),

    url: () => pwPage.url(),

    close: () => pwPage.close(),
  });

  return {
    async createPage(opts: CreatePageOptions = {}) {
      const pwPage = await context.newPage();
      if (opts.onNavigationRequest) {
        await ensureRouted();
        await adopt(pwPage, opts.onNavigationRequest, opts.network, opts.onDialog);
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

/**
 * Resolved through `pwPage.locator(selector)`, not a raw `document.querySelectorAll` inside
 * `evaluate` — Playwright's selector engine understands its own extended pseudo-classes
 * (`:text-is()`, `:nth-match()`), and `perceive()` below hands out exactly those in the
 * `text`/disambiguated tiers. A `queryAll` that only understood plain CSS would reject an
 * anchor's own locator, which is the one thing "resolves back to a locator `queryAll`
 * accepts" (S4a) rules out.
 */
async function extract(
  pwPage: PwPage,
  selector: string,
  fields: ExtractSpec,
  opts: import("./driver.js").ExtractOptions = {},
): Promise<ExtractedRecord[]> {
  const root = locatorOf(pwPage, selector);
  if (Object.keys(fields).length > 32) throw new AppError("browser.invalid_extract_fields", "extraction supports at most 32 fields");
  // Validate even when there are no rows. Let Playwright parse its own selector language;
  // do not mistake a disconnected browser or other infrastructure error for bad syntax.
  for (const [name, field] of Object.entries(fields)) {
    if (!field.selector) continue;
    try {
      await root.locator(field.selector).count();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/invalid selector|not a valid selector|while parsing|Unknown engine|Unexpected token|Unsupported token|is not a valid XPath/i.test(message)) throw error;
      throw new AppError("browser.invalid_extract_selector",
        `Invalid extraction selector for field ${JSON.stringify(name)}: ${JSON.stringify(field.selector)}. Correct this field and retry page.extract; omit it only if optional. This does not mean the page is unavailable.`,
        { cause: error, details: { field: name, selector: field.selector } });
    }
  }
  const records: ExtractedRecord[] = [];
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 100)));
  const maxFieldChars = Math.max(1, Math.min(16_000, Math.floor(opts.maxFieldChars ?? 16_000)));
  for (let index = offset, count = Math.min(await root.count(), offset + limit); index < count; index++) {
    const row = root.nth(index);
    const record: ExtractedRecord = {};
    for (const [name, field] of Object.entries(fields)) {
      const target = field.selector ? row.locator(field.selector).first() : row;
      // evaluateAll returns immediately for missing optional fields, preserving null
      // semantics without a locator auto-wait for every absent field.
      record[name] = await target.evaluateAll((els: DomNode[], args: { attr?: string; maxFieldChars: number }) => {
        const el = els[0];
        const value = el ? (args.attr ? el.getAttribute(args.attr) : (el.textContent ?? "").trim()) : null;
        if (value && value.length > args.maxFieldChars) throw new Error("extraction field exceeds maxFieldChars; narrow the selector or increase the bound");
        return value;
      }, { attr: field.attr, maxFieldChars });
    }
    records.push(record);
  }
  return records;
}

const frameMaps = new WeakMap<PwPage, Map<string, Frame>>();
function framesOf(page: PwPage): Map<string, Frame> {
  let frames = frameMaps.get(page);
  if (!frames) { frames = new Map(); frameMaps.set(page, frames); }
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || [...frames.values()].includes(frame)) continue;
    frames.set(`f${frames.size + 1}`, frame);
  }
  return frames;
}
function frameTarget(page: PwPage, selector: string): { frame: Frame; selector: string } {
  const match = /^@frame:(f[0-9]+) >> ([\s\S]+)$/.exec(selector);
  if (!match) return { frame: page.mainFrame(), selector };
  const frame = framesOf(page).get(match[1]!);
  if (!frame || frame.isDetached()) throw new Error("stale frame; perceive again");
  return { frame, selector: match[2]! };
}
function locatorOf(page: PwPage, selector: string): Locator {
  const target = frameTarget(page, selector);
  return target.frame.locator(target.selector);
}
/** Pin the actual DOM node before effects. A clone carrying our data attribute is not
 * the observed node, and replacing the node between validation and click cannot retarget it. */
async function withTarget<T>(page: PwPage, selector: string, action: (target: Locator | ElementHandle) => Promise<T>): Promise<T> {
  const locator = locatorOf(page, selector);
  if (!selector.includes("[data-tabductor-node=")) return action(locator);
  if (await locator.count() !== 1) throw new Error("stale or ambiguous snapshot target; perceive again");
  const handle = await locator.elementHandle();
  if (!handle) throw new Error("stale snapshot target; perceive again");
  try {
    const valid = await handle.evaluate(el => {
      const node = el as unknown as {isConnected:boolean;getAttribute:(name:string)=>string|null};
      const state = (globalThis as unknown as {__tabductorPerception?:{ids:WeakMap<object,string>}}).__tabductorPerception;
      return node.isConnected && state?.ids.get(el) === node.getAttribute("data-tabductor-node");
    });
    if (!valid) throw new Error("snapshot node was replaced; perceive again");
    return await action(handle);
  } finally { await handle.dispose(); }
}
async function perceive(page: PwPage, opts: PerceiveOptions = {}): Promise<Perception> {
  const frames = framesOf(page);
  const selected = opts.selector ? frameTarget(page, opts.selector) : { frame: opts.frameId && opts.frameId !== "main" ? frames.get(opts.frameId) : page.mainFrame(), selector: undefined };
  if (!selected.frame || selected.frame.isDetached()) throw new Error("frame unavailable; perceive again");
  const value = await selected.frame.evaluate(`(${PERCEPTION_SCRIPT})(${JSON.stringify({ ...opts, selector: selected.selector })})`) as Perception;
  const frameId = [...frames].find(([, frame]) => frame === selected.frame)?.[0];
  if (frameId) for (const element of value.elements) {
    element.anchor = `${frameId}-${element.anchor}`;
    if (element.parentAnchor) element.parentAnchor = `${frameId}-${element.parentAnchor}`;
    element.locator = `@frame:${frameId} >> ${element.locator}`;
    element.actionLocator = `@frame:${frameId} >> ${element.actionLocator}`;
    element.frameId = frameId;
    try { element.frameOrigin = new URL(selected.frame.url()).origin; } catch { element.frameOrigin = "null"; }
  }
  if (frameId && value.scopeAnchor) value.scopeAnchor = `${frameId}-${value.scopeAnchor}`;
  const available = [...frames].filter(([, frame]) => !frame.isDetached());
  const frameOffset = opts.frameOffset ?? 0;
  value.frameOffset = frameOffset;
  value.frames = available.slice(frameOffset, frameOffset + 50).map(([id, frame]) => ({id, url: frame.url().slice(0, 300)}));
  value.nextFrameOffset = frameOffset + 50 < available.length ? frameOffset + 50 : null;
  return value;
}
