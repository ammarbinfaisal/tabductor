import type { NavCause } from "@tabductor/policy";

/**
 * The driver interface (§20). One of the few sanctioned abstractions in this codebase, and
 * it exists for one reason: Playwright is a dependency we may have to replace, and every
 * call site that names a `Page` from `playwright-core` is a call site that would have to be
 * rewritten if we did. Nothing here mentions Playwright, and nothing outside
 * `playwright-driver.ts` imports it.
 *
 * The surface is deliberately what Phases 3–4 need and nothing more. It is not a facade
 * over Playwright — it is the vocabulary the agent's tool registry (S4b) and the compiled
 * runtime's `ctx.page` (S6a) both speak, so a method here becomes a tool there, and a
 * method nobody needs becomes a tool the model can waste a step on.
 */

/** What the runtime asks about a navigation before it is allowed to happen. */
export type NavigationRequest = { url: string; cause: NavCause };

/**
 * The guard the session installs. `false` aborts the request in flight. Async because the
 * real check is `PolicyGate.checkNavigation`, and a policy evaluator that reads grants from
 * the database is exactly what Phase 7 makes this.
 */
export type NavigationHook = (req: NavigationRequest) => Promise<boolean>;

/**
 * One field to pull out of each matched element. Omit `selector` to read the element
 * itself; omit `attr` to read its trimmed text. Anchors the compiler will need later come
 * from the *selectors*, so extraction is declared as data rather than as a callback — a
 * closure could not be recorded into a trace, and §11 needs the trace to know what was read.
 */
export type FieldSpec = { selector?: string; attr?: string };

export type ExtractSpec = Record<string, FieldSpec>;

export type ExtractedRecord = Record<string, string | null>;

/**
 * A stable id (`e1`, `e2`, …) assigned to a perceived element in document order — how the
 * agent (S4b) refers to something on the page without ever holding a selector itself.
 */
export type Anchor = string;

/**
 * Which family of identity a locator was built from, most durable first — recorded per
 * element so a later reader (the S6 compiler) knows how much to trust it surviving a layout
 * change. Describes provenance, not the concrete selector syntax `locator` ended up using.
 */
export type LocatorStrategy = "testid" | "role" | "text" | "css-path";

export type AnchoredElement = {
  anchor: Anchor;
  tag: string;
  /** ARIA role, explicit or inferred from tag/type — null when neither is determinable. */
  role: string | null;
  /** Best-effort accessible name (aria-label/alt/placeholder/value) or trimmed text. */
  name: string | null;
  /** Trimmed, truncated text content — never raw HTML (§16 Threat 1). */
  text: string | null;
  strategy: LocatorStrategy;
  /**
   * The selector `Page` methods accept. Never hand this to the model — it sees only the
   * anchor; resolve one back to this through `RunSession.resolveAnchor` (session.ts).
   */
  locator: string;
};

export type Perception = {
  url: string;
  title: string;
  elements: AnchoredElement[];
  /** Main-page text, budgeted to `PerceiveOptions.maxChars` — no raw HTML ever appears here. */
  text: string;
};

export type PerceiveOptions = {
  /** Character budget for `text` — tokens are provider-specific, chars are not (default 8000). */
  maxChars?: number;
};

export type Page = {
  goto: (url: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  type: (selector: string, text: string) => Promise<void>;
  waitFor: (selector: string, opts?: { timeout?: number }) => Promise<void>;
  queryAll: (selector: string, fields: ExtractSpec) => Promise<ExtractedRecord[]>;
  /** The perception builder (S4a §8): salient elements anchored in document order, plus
   * budgeted main text. One `evaluate`-style call, kept inside this driver rather than issued
   * as arbitrary page-JS from agent/generated code (§12's rule constrains *that*, not us). */
  perceive: (opts?: PerceiveOptions) => Promise<Perception>;
  screenshot: () => Promise<Buffer>;
  title: () => Promise<string>;
  url: () => string;
  close: () => Promise<void>;
};

/**
 * §9 step 1's normalized shape, minus `index` — indexing is a session-level ordinal (a tab
 * opened later must not collide with one still generating traffic on an earlier tab), so it
 * is assigned by whatever holds `network`, not by the driver, which only sees one page's
 * traffic at a time.
 */
export type NetworkRecord = {
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  timings: { startedAt: number; endedAt: number | null; durationMs: number | null };
};

/** What `NetworkHooks.onSettled` hands back for a request that got a response. */
export type NetworkBody = { bytes: Buffer; mime: string };

/**
 * Fired twice for a request that gets a response, once for one that doesn't. `onStart` fires
 * first, with `status: null` — §9 step 2 requires a pending request to already be listable,
 * so the record has to exist before its outcome does. `onSettled` fires once more, with the
 * *same* `record` reference now mutated in place (status/timings filled in), so a caller that
 * kept the reference from `onStart` sees the update without a second lookup. `body` resolves
 * the response body lazily — nothing here has read it yet — and rejects for a failed request,
 * which never gets one.
 */
export type NetworkHooks = {
  onStart?: (record: NetworkRecord) => void | Promise<void>;
  onSettled?: (record: NetworkRecord, body: () => Promise<NetworkBody>) => void | Promise<void>;
};

export type CreatePageOptions = {
  /**
   * Applies to this page *and to anything it opens*. A popup is the classic way around a
   * per-page check (§16), so the implementation must attribute a new page to its opener
   * rather than treating it as unguarded.
   */
  onNavigationRequest?: NavigationHook;
  /** Same popup attribution as `onNavigationRequest`; absent means this page is unobserved. */
  network?: NetworkHooks;
};

export type BrowserConn = {
  createPage: (opts?: CreatePageOptions) => Promise<Page>;
  /** `Browser.getVersion` — the health-check ping S3b's pool loop will run. */
  version: () => Promise<string>;
  /**
   * Fires the moment the underlying connection drops, out of band from any in-flight
   * call — S3b's pool needs this the instant Playwright itself knows, rather than waiting
   * for the next health-loop tick to notice a dead ping. Optional: a driver that cannot
   * detect this out of band leaves the pool relying on the ping alone.
   */
  onDisconnect?: (cb: () => void) => void;
  close: () => Promise<void>;
};

export type Driver = {
  /**
   * `wsUrl` is a user's CDP endpoint: a bearer credential (§16 Threat 5). It is never
   * logged, never traced, and never put in a span attribute.
   */
  connect: (wsUrl: string) => Promise<BrowserConn>;
};
