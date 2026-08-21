import type { ExtractedRecord, ExtractSpec, RunSession } from "@tabductor/browser";

/**
 * `ctx` — the compiled script's entire window on the world (techical_plan §12).
 *
 * This is the §4 security boundary expressed as a surface rather than a rule. There is no
 * `ctx.mcp`, no `ctx.assets.write`/`.append`, no `page.evaluate` or any other arbitrary-JS
 * door, and no `page.download` — not because something denies them, but because the isolate
 * has no other binding at all. A compiled browser script gets exactly the browser node's
 * capabilities, which is what makes "the compiled fast path and the AI slow path go through
 * the same door" (§2 principle 3) true of the door and not just of the intention.
 *
 * Every `page.*` method binds to `RunSession`'s method **verbatim**. That crossing *is* the
 * reuse: the session already runs each action through `PolicyGate` inside its own `act()`
 * wrapper, so this adds no second gate. A denial a compiled script sees is the same denial an
 * agent sees, produced by the same check.
 */

/** Structurally identical to `@tabductor/agent`'s `EmitFn`, declared locally on purpose:
 * both packages are consumed by executors and neither by the other, so importing across
 * would invert a layering that currently has no edge at all. */
export type EmitOutcome = { ok: true; eventId: string } | { ok: false; error: string } | { ok: true; deduped: true };
export type EmitFn = (type: string, packet: unknown, opts?: { dedupeKey?: string }) => Promise<EmitOutcome>;

/** One failed check from the most recent `ctx.guard.all(...)`. */
export type GuardFailure = { check: string; detail: Record<string, unknown> };

/** Per-key task state, backing both `ctx.state` and (in S6c) `emitIfNew`'s dedupe claim. */
export type StateStore = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
};

/**
 * What the host supplies. Everything here is a real capability already built and already
 * gated; `runCompiledScript` only makes them reachable from inside the isolate.
 */
export type CtxHost = {
  session: RunSession;
  emit: EmitFn;
  state: StateStore;
  /** Resolves an asset ref to the bytes `page.upload` needs. Absent = `ctx.page.upload`
   * rejects, which is what a task with no asset grant should see. */
  resolveAsset?: (assetRef: unknown) => Promise<{ name: string; mimeType: string; bytes: Buffer }>;
};

/** `page.evalExtract`'s result, passed back into the isolate by copy. */
export type ExtractResult = ExtractedRecord[];

export type { ExtractSpec };
