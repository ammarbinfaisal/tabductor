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

export type Page = {
  goto: (url: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  type: (selector: string, text: string) => Promise<void>;
  waitFor: (selector: string, opts?: { timeout?: number }) => Promise<void>;
  queryAll: (selector: string, fields: ExtractSpec) => Promise<ExtractedRecord[]>;
  screenshot: () => Promise<Buffer>;
  title: () => Promise<string>;
  url: () => string;
  close: () => Promise<void>;
};

export type CreatePageOptions = {
  /**
   * Applies to this page *and to anything it opens*. A popup is the classic way around a
   * per-page check (§16), so the implementation must attribute a new page to its opener
   * rather than treating it as unguarded.
   */
  onNavigationRequest?: NavigationHook;
};

export type BrowserConn = {
  createPage: (opts?: CreatePageOptions) => Promise<Page>;
  /** `Browser.getVersion` — the health-check ping S3b's pool loop will run. */
  version: () => Promise<string>;
  close: () => Promise<void>;
};

export type Driver = {
  /**
   * `wsUrl` is a user's CDP endpoint: a bearer credential (§16 Threat 5). It is never
   * logged, never traced, and never put in a span attribute.
   */
  connect: (wsUrl: string) => Promise<BrowserConn>;
};
