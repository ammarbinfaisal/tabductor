import ivm from "isolated-vm";
import { installUrlGlobals } from "./url-globals.js";

export type ToolScriptResult =
  | { outcome: "completed"; value: unknown; calls: number }
  | { outcome: "error" | "killed" | "yielded"; error: string; calls: number; effectsSettled: boolean; limit?: "wall_clock" | "cpu_or_memory" | "calls" | "cooperative" };

/** An isolated program can only call the host's validated tool registry. No host objects,
 * imports, filesystem, timers, process, or independent network access enter this realm.
 * Calls are serialized even if the guest uses Promise.all or forgets to await them.
 */
export async function runToolScript(source: string,
  call: (name: string, args: unknown, signal: AbortSignal, waitForControl: <T>(wait: () => Promise<T>) => Promise<T>) => Promise<unknown>,
  opts: { signal?: AbortSignal; wallClockMs?: number; maxCalls?: number; yieldBeforeMs?: number; settleMs?: number } = {},
): Promise<ToolScriptResult> {
  const wallClockMs = Math.max(1, Math.min(30_000, opts.wallClockMs ?? 30_000));
  const maxCalls = Math.max(1, Math.min(100, opts.maxCalls ?? 100));
  const isolate = new ivm.Isolate({ memoryLimit: 32 });
  const controller = new AbortController();
  let calls = 0;
  let submitted = 0;
  let budgetQueries = 0;
  let argumentChars = 0;
  let inFlight = 0;
  let closed = false;
  let killed = false;
  let yielded = false;
  let limit: "wall_clock" | "cpu_or_memory" | "calls" | "cooperative" | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let rejectStopped: (error: Error) => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  void stopped.catch(() => undefined);
  const stop = () => {
    closed = true;
    controller.abort();
    rejectStopped(new Error("code execution ended"));
    if (!isolate.isDisposed) isolate.dispose();
  };
  let remainingMs = wallClockMs;
  let resumedAt = Date.now();
  const expire = () => { killed = true; limit = "wall_clock"; stop(); };
  let timer = setTimeout(expire, remainingMs);
  // Only the host may suspend wall time while waiting for human control. Guest CPU
  // remains bounded by isolated-vm's timeout even when it neglects to await that call.
  const waitForControl = async <T>(wait: () => Promise<T>): Promise<T> => {
    remainingMs -= Date.now() - resumedAt;
    clearTimeout(timer);
    try { return await Promise.race([wait(), stopped]); }
    finally {
      resumedAt = Date.now();
      if (!closed) timer = setTimeout(expire, Math.max(0, remainingMs));
    }
  };
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (opts.signal?.aborted) throw new Error("run_cancelled");
    if (source.length > 24_000) throw new Error("code exceeds 24000 characters");
    const context = await isolate.createContext();
    await installUrlGlobals(context, wallClockMs);
    const factory = await context.eval(`(function(dispatch) {
      const call = async function(name, args) {
        const wire = JSON.stringify({name, args: args === undefined ? {} : args});
        if (wire.length > 1000000) throw new Error('tool arguments exceed 1 MB');
        const result = await dispatch.apply(undefined, [wire], {
          arguments: {copy: true}, result: {promise: true, copy: true}
        });
        return JSON.parse(result);
      };
      return Object.freeze({call, budget: () => call('__budget', {}), yield: () => call('__yield', {})});
    })`, { reference: true, timeout: wallClockMs });
    const api = await factory.apply(undefined, [new ivm.Reference((wire: string) => {
      if (typeof wire !== "string" || wire.length > 1_000_000 || ++budgetQueries > 1000 || (argumentChars += wire.length) > 4_000_000) {
        const rejected = Promise.reject(new Error("code bridge budget exceeded"));
        void rejected.catch(() => undefined);
        return rejected;
      }
      const request = JSON.parse(wire) as { name: string };
      if (request.name === "__budget") return Promise.resolve(JSON.stringify({ remainingMs: Math.max(0, remainingMs - (Date.now() - resumedAt)), remainingCalls: maxCalls - submitted }));
      if (request.name === "__yield") { yielded = true; limit = "cooperative"; return Promise.resolve("null"); }
      // Admission happens before queueing: an unawaited guest loop cannot build an
      // unbounded host queue while the first browser operation is still running.
      if (++submitted > maxCalls) {
        const rejected = Promise.reject(new Error("code tool-call or argument budget exceeded"));
        void rejected.catch(() => undefined);
        return rejected;
      }
      const pending = queue.then(async () => {
        if (closed || controller.signal.aborted) throw new Error("code execution ended");
        if (yielded || (opts.yieldBeforeMs !== undefined && (remainingMs - (Date.now() - resumedAt) <= opts.yieldBeforeMs || calls >= maxCalls - 1))) {
          yielded = true; limit ??= calls >= maxCalls - 1 ? "calls" : "wall_clock";
          throw new Error("code yielded before its budget; resume from acknowledged progress");
        }
        calls++;
        const { name, args } = JSON.parse(wire) as { name: string; args: unknown };
        inFlight++;
        let value: unknown;
        try { value = await call(name, args, controller.signal, waitForControl); } finally { inFlight--; }
        const result = JSON.stringify(value) ?? "null";
        if (result.length > 1_000_000) throw new Error("tool result exceeds 1 MB; read a smaller batch");
        return result;
      });
      queue = pending.catch(() => undefined);
      return pending;
    })], { result: { reference: true } });
    const module = await isolate.compileModule(source);
    await module.instantiate(context, () => { throw new Error("imports are not allowed in browser code"); });
    await Promise.race([module.evaluate({ timeout: wallClockMs }), stopped]);
    const run = await module.namespace.get("default", { reference: true });
    if (!run || run.typeof !== "function") throw new Error("export a default async function accepting tools");
    // Serialize and limit the result inside the isolate, before copying it into the host.
    const invoke = await context.eval(`(async function(run, tools) {
      const result = JSON.stringify(await run(tools)) ?? 'null';
      if (result.length > 8000) throw new Error('return a summary of at most 8000 characters');
      return result;
    })`, { reference: true });
    const result = await invoke.apply(undefined, [run.derefInto(), api.derefInto()],
      { timeout: wallClockMs, result: { promise: true, copy: true } });
    await Promise.race([queue, stopped]);
    if (closed) throw new Error("code execution ended");
    if (yielded) return { outcome: "yielded", error: "Resume from acknowledged progress", calls, effectsSettled: true, limit };
    return { outcome: "completed", value: JSON.parse(String(result)), calls };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exceeded = killed || inFlight > 0 || isolate.isDisposed || /timed out|memory limit/i.test(message);
    if (exceeded) {
      limit ??= "cpu_or_memory";
      stop();
      // A killed guest is not proof its host effect stopped. Drain admitted work before
      // returning; unresolved effects remain explicitly uncertain and cannot be replayed.
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([queue, new Promise(resolve => { settleTimer = setTimeout(resolve, opts.settleMs ?? 5000); })]);
      clearTimeout(settleTimer);
    }
    return { outcome: exceeded ? "killed" : yielded ? "yielded" : "error",
      error: opts.signal?.aborted ? "run_cancelled" : message.slice(0, 1000), calls, effectsSettled: inFlight === 0, limit };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
    stop();
  }
}
