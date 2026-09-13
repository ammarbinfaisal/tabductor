import type { Page, RunSession } from "@tabductor/browser";
import { runCompiledScript, type CtxHost, type EmitOutcome } from "@tabductor/static-rt";
import type { Metrics } from "@tabductor/telemetry";
import type { RunEvidence } from "./evidence.js";

/**
 * Validation with no live page in it at all.
 *
 * The old dry run borrowed the workflow's own endpoint and drove the real site. Suppressing
 * the event bus made the *emission* harmless; it did nothing about the click that posts the
 * reply, the form that submits the order or the message that sends — and `trace-compilation.md`
 * is explicit that suppressing emissions alone does not make a live replay safe. So this file
 * builds the page out of the evidence instead: a `RunSession` whose every method answers from
 * what the completed run recorded, and which therefore cannot reach the network to do anything
 * to anyone.
 *
 * What that buys, beyond safety:
 *
 * - **Ungrounded moves fail loudly.** A script that navigates somewhere no trace went, or waits
 *   on a selector no trace saw, throws here rather than silently working against a live page
 *   that happens to be forgiving today.
 * - **The work has to actually happen.** The extraction rows are synthetic (the trace records
 *   counts and field names, never values — §14), but there are as many of them as the run saw,
 *   so a script that emits nothing, or emits once for a ten-row page, fails validation.
 * - **Idempotency is provable.** Running the same script twice against the same state store
 *   must publish nothing the second time. A script that forgot `dedupeKey` cannot pass.
 * - **The deopt door has to work.** A second pass with the guard's own selector removed must
 *   end in `deopt`, not a throw: "a deopt alone is not proof the work succeeds" (S6b), but a
 *   script that cannot deopt cleanly is one that will fail a run outright the day the page moves.
 *
 * This is not a claim that the script works on the live site. Nothing short of running it there
 * is, and running it there is the thing we may not do. It is the strongest isolated statement
 * available, and the guards plus the deopt door are what cover the rest.
 */

export type ValidationResult =
  | { ok: true; emitted: { type: string; dedupeKey: string | undefined }[] }
  | { ok: false; reason: string };

type Captured = { type: string; packet: unknown; dedupeKey: string | undefined };

/** Deterministic stand-in values: distinct per row so dedupe keys differ, obviously fake so a
 * script that hard-codes one is caught the first time it runs for real. */
function syntheticRow(fields: string[], index: number): Record<string, string | null> {
  const row: Record<string, string | null> = {};
  for (const field of fields) row[field] = `${field}-${index + 1}`;
  return row;
}

type HostOptions = {
  /** Selectors to pretend are gone — how the guard-failure pass is built. */
  missing?: Set<string>;
  /** Selectors the plan declared and a guard asserts, which the traces never named literally
   * (`plan.ts`: an agent walks anchors, a script addresses the collection). They answer like
   * a real selector here, with the collection's size behind them. */
  assumed?: Set<string>;
  /** How many rows the work has to handle — see `collectionSize`. */
  rows?: number;
  /** Shared across passes so the second run of the same script sees the first run's cursor. */
  state?: Map<string, unknown>;
  /** Shared across passes so a repeated dedupe key is deduped, exactly as the real emit is. */
  claimed?: Set<string>;
  dialog?: boolean;
};

type ValidationHost = { host: CtxHost; emitted: Captured[]; published: Captured[] };

function buildHost(evidence: RunEvidence, opts: HostOptions = {}): ValidationHost {
  const missing = opts.missing ?? new Set<string>();
  const assumed = opts.assumed ?? new Set<string>();
  const state = opts.state ?? new Map<string, unknown>();
  const claimed = opts.claimed ?? new Set<string>();
  const emitted: Captured[] = [];
  const published: Captured[] = [];

  const known = new Set<string>([...evidence.selectors, ...evidence.extractions.map((e) => e.selector), ...assumed]);
  const collection = opts.rows ?? collectionSize(evidence);
  const rowsFor = (selector: string): number =>
    evidence.extractions.find((e) => e.selector === selector)?.rows ?? (assumed.has(selector) ? collection : 0);

  let currentUrl = evidence.navigations[0] ?? "about:blank";

  const reachable = (url: string): boolean =>
    evidence.navigations.some((seen) => {
      if (seen === url) return true;
      try {
        const a = new URL(seen);
        const b = new URL(url);
        return a.origin === b.origin && a.pathname === b.pathname;
      } catch {
        return false;
      }
    });

  const requireSelector = (op: string, selector: string): void => {
    if (missing.has(selector)) throw new Error(`${op}: ${JSON.stringify(selector)} is not on the page`);
    if (!known.has(selector)) {
      throw new Error(`${op}: ${JSON.stringify(selector)} was never addressed by the run this was compiled from`);
    }
  };

  const page: Page = {
    async goto(url) {
      if (!reachable(url)) throw new Error(`goto: ${url} was never reached by the run this was compiled from`);
      currentUrl = url;
    },
    async click(selector) {
      requireSelector("click", selector);
    },
    async type(selector, _text) {
      requireSelector("type", selector);
    },
    async waitFor(selector, _opts) {
      requireSelector("waitFor", selector);
    },
    async queryAll(selector, fields) {
      requireSelector("queryAll", selector);
      const names = Object.keys(fields);
      const count = rowsFor(selector);
      return Array.from({ length: count }, (_, i) => (names.length === 0 ? {} : syntheticRow(names, i)));
    },
    async probeTarget() {
      return null;
    },
    async insertTextRaw() {
      throw new Error("insertTextRaw is not reachable from a compiled script");
    },
    async perceive() {
      return { elements: [], text: "", url: currentUrl, title: "" };
    },
    async upload(selector) {
      requireSelector("upload", selector);
    },
    async scroll(_direction) {},
    async screenshot() {
      return Buffer.alloc(0);
    },
    async title() {
      return "";
    },
    url() {
      return currentUrl;
    },
    async close() {},
  };

  const session: RunSession = {
    page,
    network: {
      async list() {
        return { records: [], total: 0 };
      },
      async body() {
        throw new Error("network.body is not available during isolated validation");
      },
      async read() {
        return {};
      },
    },
    dialogSeen: () => opts.dialog === true,
    async openTab() {
      return page;
    },
    resolveAnchor: () => undefined,
    async close() {},
  };

  const emit: CtxHost["emit"] = async (type, packet, emitOpts): Promise<EmitOutcome> => {
    const dedupeKey = emitOpts?.dedupeKey;
    emitted.push({ type, packet, dedupeKey });
    if (dedupeKey !== undefined) {
      const key = `${type}:${dedupeKey}`;
      if (claimed.has(key)) return { ok: true, deduped: true };
      claimed.add(key);
    }
    published.push({ type, packet, dedupeKey });
    return { ok: true, eventId: `validation-${published.length}` };
  };

  return {
    host: {
      session,
      emit,
      state: {
        async get(key) {
          return state.get(key) ?? null;
        },
        async set(key, value) {
          state.set(key, value);
        },
      },
    },
    emitted,
    published,
  };
}

/**
 * How much data the work actually had.
 *
 * Two shapes mean the same thing and the trace records them differently: an agent that
 * extracted a five-row collection in one call, and an agent that walked five anchors and
 * extracted one row from each. The second is what a real agent run looks like, and reading it
 * as "one row" would let a script that emits once pass validation for a page with five items
 * on it.
 */
function collectionSize(evidence: RunEvidence): number {
  const widest = evidence.extractions.reduce((max, e) => Math.max(max, e.rows), 0);
  const walked = evidence.extractions.filter((e) => e.rows > 0).length;
  return Math.max(widest, walked);
}

/** The selector the guard-failure pass removes: the first `exists` guard the script checks,
 * found by running the script once and watching what it asks for. Falling back to the widest
 * extraction selector covers a script whose guards are URL-only. */
function guardTarget(evidence: RunEvidence, source: string): string | undefined {
  const exists = /ctx\.guard\.exists\(\s*(["'`])([^"'`]+)\1/.exec(source);
  if (exists?.[2] !== undefined && exists[2] !== "") return exists[2];
  return evidence.extractions[0]?.selector;
}

export type ValidateOptions = {
  metrics?: Metrics;
  wallClockMs?: number;
  /** Selectors the approved plan declared, which the traces never named literally. */
  assumeSelectors?: string[];
};

/**
 * Three passes, in order, each a precondition for the next being meaningful.
 *
 * 1. The work, on the evidence's own shape: must complete, must publish every event type the
 *    run published, must publish one per extracted row.
 * 2. The same script again, same state: must publish nothing new.
 * 3. The page moved: must `deopt`, not throw and not silently emit.
 */
export async function validateCandidate(
  source: string,
  evidence: RunEvidence,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  const state = new Map<string, unknown>();
  const claimed = new Set<string>();
  const assumed = new Set(opts.assumeSelectors ?? []);
  const rows = collectionSize(evidence);
  const runOpts = { ...(opts.metrics ? { metrics: opts.metrics } : {}), ...(opts.wallClockMs ? { wallClockMs: opts.wallClockMs } : {}) };

  const first = buildHost(evidence, { state, claimed, assumed, rows });
  const work = await runCompiledScript(source, first.host, runOpts);
  if (work.outcome !== "completed") {
    return {
      ok: false,
      reason:
        work.outcome === "deopt"
          ? `the script deopted on the very evidence it was compiled from: ${JSON.stringify(work.evidence)}`
          : work.outcome === "error"
            ? `the script threw against its own evidence: ${work.error}`
            : `the script was killed during validation: ${work.reason}`,
    };
  }

  for (const observed of evidence.emits) {
    const count = first.published.filter((e) => e.type === observed.type).length;
    if (count === 0) {
      return { ok: false, reason: `the run published "${observed.type}" and the script published none` };
    }
  }
  if (first.published.some((e) => e.dedupeKey === undefined)) {
    return { ok: false, reason: "the script emits without a dedupe key — a re-run would publish duplicates" };
  }
  // One event per extracted row: a script that emits a single event for a ten-row page has
  // collapsed the work, and the rows are the one quantity the trace actually recorded.
  if (evidence.emits.length > 0 && rows > 1 && first.published.length < rows) {
    return {
      ok: false,
      reason: `the page had ${rows} rows to work with and the script published ${first.published.length} event(s)`,
    };
  }

  const again = buildHost(evidence, { state, claimed, assumed, rows });
  const repeat = await runCompiledScript(source, again.host, runOpts);
  if (repeat.outcome !== "completed") {
    return { ok: false, reason: `the second, idempotent pass did not complete: ${repeat.outcome}` };
  }
  if (again.published.length > 0) {
    return {
      ok: false,
      reason: `re-running the script published ${again.published.length} event(s) a second time — it is not idempotent`,
    };
  }

  const target = guardTarget(evidence, source);
  const moved = buildHost(evidence, {
    state: new Map(),
    claimed: new Set(),
    assumed,
    rows,
    ...(target !== undefined ? { missing: new Set([target]) } : { dialog: true }),
  });
  const changed = await runCompiledScript(source, moved.host, runOpts);
  if (changed.outcome !== "deopt") {
    return {
      ok: false,
      reason:
        changed.outcome === "completed"
          ? `with ${target === undefined ? "a dialog in the way" : `${JSON.stringify(target)} gone`} the script still claimed success — its guards check nothing`
          : `with the page changed the script ${changed.outcome === "error" ? `threw (${changed.error})` : "was killed"} instead of deopting`,
    };
  }
  if (moved.published.length > 0) {
    return { ok: false, reason: "the script published events before deopting on a page it did not recognise" };
  }

  return { ok: true, emitted: first.published.map((e) => ({ type: e.type, dedupeKey: e.dedupeKey })) };
}
