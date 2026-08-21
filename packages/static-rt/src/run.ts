import ivm from "isolated-vm";
import type { Metrics } from "@tabductor/telemetry";
import { BOOTSTRAP } from "./bootstrap.js";
import type { CtxHost, ExtractSpec, GuardFailure } from "./ctx.js";

/**
 * The cage. One isolate per run, `ctx` as its only binding, two caps that always apply.
 *
 * **Caps have no "absent = unlimited" here**, unlike `limits_json.browser` (§8): `isolated-vm`
 * requires a finite `memoryLimit` at construction, and a run with no timeout defeats the point
 * of having a cap at all. So both always apply, at the defaults below, and a task's
 * `limits_json.static_rt` may only *tighten* them.
 */
export const DEFAULT_WALL_CLOCK_MS = 10_000;
export const DEFAULT_MEMORY_MB = 64;

export type ScriptRunResult =
  | { outcome: "completed" }
  /** `ctx.deopt` was called. Not a failure: S6c hands off to `AgentExecutor` on the same run
   * row, and S6b's dry-run treats it as a clean pipeline result. */
  | { outcome: "deopt"; prompt: string; evidence: unknown }
  | { outcome: "killed"; reason: "wall_clock" | "memory" }
  | { outcome: "error"; error: string };

export type RunOptions = {
  wallClockMs?: number;
  memoryMb?: number;
  metrics?: Metrics;
};

/** Everything the isolate may ask the host to do, by the path the bootstrap calls it with. */
function buildDispatch(
  host: CtxHost,
  onDeopt: (prompt: string, evidence: unknown) => void,
): (path: string, args: unknown[]) => Promise<unknown> {
  const { session } = host;
  // `guard.all` correlates its results array against this log **by index**, so the log has to
  // be in *call* order. That means logging when a check is dispatched, never when it resolves:
  // §11's template builds `[url(...), exists(...), noDialog()]` and `exists` is the slow one,
  // so completion order is not call order and correlating on it silently mislabels every
  // failure. The returned entry stays mutable so a check can fill in what it learns.
  let checkLog: { check: string; detail: Record<string, unknown> }[] = [];
  let lastFailures: GuardFailure[] = [];

  const logCheck = (check: string, detail: Record<string, unknown>): { detail: Record<string, unknown> } => {
    const entry = { check, detail };
    checkLog.push(entry);
    return entry;
  };

  return async (path, args) => {
    switch (path) {
      case "page.goto":
        return session.page.goto(args[0] as string);
      case "page.click":
        return session.page.click(args[0] as string);
      case "page.type":
        return session.page.type(args[0] as string, args[1] as string);
      case "page.scroll":
        return session.page.scroll(args[0] as "up" | "down");
      case "page.waitFor":
        return session.page.waitFor(args[0] as string, args[1] as { timeout?: number } | undefined);
      // Existence/count only — no fields, exactly §12's split between `query` and `evalExtract`.
      case "page.query":
        return session.page.queryAll(args[0] as string, {});
      case "page.evalExtract":
        return session.page.queryAll(args[0] as string, (args[1] ?? {}) as ExtractSpec);
      case "page.screenshot":
        return (await session.page.screenshot()).toString("base64");
      case "page.url":
        return session.page.url();
      case "page.upload": {
        if (!host.resolveAsset) {
          throw new Error("page.upload is unavailable: this task has no asset resolver");
        }
        const selector = session.resolveAnchor(args[0] as string) ?? (args[0] as string);
        return session.page.upload(selector, await host.resolveAsset(args[1]));
      }

      case "guard.url": {
        const pattern = args[0] as string;
        const actual = session.page.url();
        logCheck("url", { pattern, actual });
        return new RegExp(pattern).test(actual);
      }
      case "guard.exists": {
        const selector = args[0] as string;
        logCheck("exists", { selector });
        return session.page
          .waitFor(selector, args[1] as { timeout?: number } | undefined)
          .then(() => true, () => false);
      }
      case "guard.text": {
        const selector = args[0] as string;
        const matcher = args[1] as string;
        const entry = logCheck("text", { selector, matcher });
        const rows = await session.page.queryAll(selector, { value: {} }).catch(() => []);
        const first = rows[0]?.value;
        entry.detail.actual = typeof first === "string" ? first : null;
        return typeof first === "string" && new RegExp(matcher).test(first);
      }
      case "guard.noDialog": {
        logCheck("noDialog", {});
        return !session.dialogSeen();
      }
      case "guard.__settle": {
        const results = (args[0] ?? []) as boolean[];
        lastFailures = checkLog
          .map((entry, i) => ({ ...entry, ok: results[i] === true }))
          .filter((entry) => !entry.ok)
          .map(({ check, detail }) => ({ check, detail }));
        checkLog = [];
        return results.every((r) => r === true);
      }
      case "guard.failures":
        return lastFailures;

      case "network.list":
        return session.network.list((args[0] ?? {}) as Parameters<typeof session.network.list>[0]);
      case "network.read":
        return session.network.read(
          args[0] as number,
          args[1] as Parameters<typeof session.network.read>[1],
        );

      case "state.get":
        return (await host.state.get(args[0] as string)) ?? null;
      case "state.set":
        return host.state.set(args[0] as string, args[1]);

      // One `EmitFn`, two spellings — not two code paths, exactly how the agent's single
      // `emit` tool already works.
      case "emit":
        return host.emit(args[0] as string, args[1]);
      case "emitIfNew": {
        const opts = args[2] as { dedupeKey?: string } | undefined;
        return host.emit(args[0] as string, args[1], opts?.dedupeKey === undefined ? undefined : opts);
      }

      case "deopt":
        onDeopt(args[0] as string, args[1]);
        return undefined;

      default:
        throw new Error(`no such ctx binding: ${path}`);
    }
  };
}

/**
 * Runs `source` — `export default async function run(ctx) { ... }`, §11's template verbatim —
 * inside a fresh isolate.
 *
 * Two wall clocks, on purpose. `isolated-vm`'s own `timeout` bounds *CPU time in the isolate*,
 * which is what stops `while (true) {}`; it does not bound a script that simply awaits a host
 * call forever, because that time is spent out here. The host-side timer below covers that
 * second case by disposing the isolate. Either way the outcome is `killed/wall_clock`.
 */
export async function runCompiledScript(
  source: string,
  host: CtxHost,
  opts: RunOptions = {},
): Promise<ScriptRunResult> {
  const wallClockMs = opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const memoryMb = opts.memoryMb ?? DEFAULT_MEMORY_MB;
  const started = Date.now();

  let deopted: { prompt: string; evidence: unknown } | undefined;
  const dispatch = buildDispatch(host, (prompt, evidence) => {
    deopted = { prompt, evidence };
  });

  const isolate = new ivm.Isolate({ memoryLimit: memoryMb });
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  const finish = (result: ScriptRunResult): ScriptRunResult => {
    opts.metrics?.staticRtRunDuration.record((Date.now() - started) / 1000, { outcome: result.outcome });
    if (result.outcome === "killed") opts.metrics?.staticRtKills.add({ reason: result.reason });
    return result;
  };

  try {
    const context = await isolate.createContext();
    // The isolate's global is bare — no `fetch`, no `process`, no `require`, no timers. The
    // only thing put on it is the one reference the bootstrap needs, and that is removed from
    // the global as soon as `ctx` has closed over it.
    const bootstrapFn = await context.eval(BOOTSTRAP, { reference: true });
    const ctxRef = await bootstrapFn.apply(
      undefined,
      [new ivm.Reference(dispatch)],
      { result: { reference: true } },
    );

    const module = await isolate.compileModule(source);
    // §12: no imports. A module that asks for one never instantiates, so this is the same
    // refusal the lint gate makes — held here too, for a script that skipped the gate.
    await module.instantiate(context, (specifier) => {
      throw new Error(`imports are not allowed in a compiled script: "${specifier}"`);
    });
    await module.evaluate();
    const runFn = await module.namespace.get("default", { reference: true });
    if (!runFn || runFn.typeof !== "function") {
      return finish({ outcome: "error", error: "compiled script has no default-exported function" });
    }

    timer = setTimeout(() => {
      timedOut = true;
      isolate.dispose();
    }, wallClockMs);

    await runFn.apply(undefined, [ctxRef.derefInto()], {
      result: { promise: true, copy: true },
      timeout: wallClockMs,
    });

    // Checked *before* how the guest settled: a script that deopts and then returns normally
    // is a deopt, not a completion.
    if (deopted) return finish({ outcome: "deopt", ...deopted });
    return finish({ outcome: "completed" });
  } catch (err) {
    if (deopted) return finish({ outcome: "deopt", ...deopted });
    const message = err instanceof Error ? err.message : String(err);
    if (timedOut || /script execution timed out/i.test(message)) {
      return finish({ outcome: "killed", reason: "wall_clock" });
    }
    // `isolated-vm` disposes the isolate itself when the cap is hit, which is the signal —
    // more reliable than matching its message, though both are checked.
    if (isolate.isDisposed || /memory limit/i.test(message)) {
      return finish({ outcome: "killed", reason: "memory" });
    }
    return finish({ outcome: "error", error: message });
  } finally {
    if (timer) clearTimeout(timer);
    if (!isolate.isDisposed) isolate.dispose();
  }
}
