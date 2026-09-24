import ivm from "isolated-vm";
import { SDK_BOOTSTRAP, type HelperRevision } from "./sdk.js";
import { installUrlGlobals } from "./url-globals.js";

export type ToolScriptResult =
  | { outcome: "completed"; value: unknown; calls: number }
  | { outcome: "error" | "killed" | "yielded"; error: string; calls: number; effectsSettled: boolean; code?: "output_too_large"; outputChars?: number; limit?: "wall_clock" | "cpu_or_memory" | "calls" | "cooperative" };

/** An isolated program can only call the host's validated tool registry. No host objects,
 * imports, filesystem, timers, process, or independent network access enter this realm.
 * Calls are serialized even if the guest uses Promise.all or forgets to await them.
 */
export async function runToolScript(source: string,
  call: (name: string, args: unknown, signal: AbortSignal, waitForControl: <T>(wait: () => Promise<T>) => Promise<T>, context?: { parent?: unknown; sdkCallId?: number }) => Promise<unknown>,
  opts: { signal?: AbortSignal; wallClockMs?: number; memoryMb?: number; maxCalls?: number; yieldBeforeMs?: number; settleMs?: number; operationNames?: string[]; input?: unknown; helpers?: HelperRevision[]; hostWaits?: boolean } = {},
): Promise<ToolScriptResult> {
  const wallClockMs = Math.max(1, Math.min(30_000, opts.wallClockMs ?? 30_000));
  const maxCalls = Math.max(1, Math.min(1000, opts.maxCalls ?? 100));
  const isolate = new ivm.Isolate({ memoryLimit: Math.max(8, Math.min(32, opts.memoryMb ?? 32)) });
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
  let waitDepth = 0;
  const waitForControl = async <T>(wait: () => Promise<T>): Promise<T> => {
    if (waitDepth++ === 0) { remainingMs -= Date.now() - resumedAt; clearTimeout(timer); }
    // Keep the queue pending until the actual host work settles. Racing this against
    // guest disposal would falsely acknowledge an in-flight browser effect as drained.
    try { return await wait(); }
    finally {
      if (--waitDepth === 0) { resumedAt = Date.now();
      if (!closed) timer = setTimeout(expire, Math.max(0, remainingMs)); }
    }
  };
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (opts.signal?.aborted) throw new Error("run_cancelled");
    if (source.length > 24_000) throw new Error("code exceeds 24000 characters");
    const context = await isolate.createContext();
    await installUrlGlobals(context, wallClockMs);
    const factory = await context.eval(SDK_BOOTSTRAP, { reference: true, timeout: wallClockMs });
    const helperMap = await context.eval("Object.create(null)", { reference: true });
    for (const helper of opts.helpers ?? []) {
      const module = await isolate.compileModule(helper.source);
      await module.instantiate(context, () => { throw new Error("imports are not allowed in browser helpers"); });
      await module.evaluate({ timeout: wallClockMs });
      const run = await module.namespace.get("default", { reference: true });
      if (!run || run.typeof !== "function") throw new Error("helper must export a default function");
      const entry = await context.eval("({})", { reference: true });
      await entry.set("revision", helper.revision, { copy: true });
      await entry.set("run", run.derefInto());
      await helperMap.set(helper.name, entry.derefInto());
    }
    const api = await factory.apply(undefined, [new ivm.Reference((wire: string) => {
      if (typeof wire !== "string" || wire.length > 1_000_000 || ++budgetQueries > 10000 || (argumentChars += wire.length) > 32_000_000) {
        const rejected = Promise.reject(new Error("code bridge budget exceeded"));
        void rejected.catch(() => undefined);
        return rejected;
      }
      const request = JSON.parse(wire) as { name: string };
      if (request.name === "__budget") return Promise.resolve(JSON.stringify({ remainingMs: Math.max(0, remainingMs - (waitDepth ? 0 : Date.now() - resumedAt)), remainingCalls: maxCalls - submitted }));
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
        if (yielded || (opts.yieldBeforeMs !== undefined && (remainingMs - (waitDepth ? 0 : Date.now() - resumedAt) <= opts.yieldBeforeMs || calls >= maxCalls - 1))) {
          yielded = true; limit ??= calls >= maxCalls - 1 ? "calls" : "wall_clock";
          throw new Error("code yielded before its budget; resume from acknowledged progress");
        }
        calls++;
        const { name, args } = JSON.parse(wire) as { name: string; args: unknown };
        inFlight++;
        // Bounded host waits do not spend guest time, but cannot keep an isolate alive forever.
        const hostTimer = opts.hostWaits ? setTimeout(expire, 125_000) : undefined;
        let value: unknown;
        try {
          const work = () => call(name, args, controller.signal, waitForControl);
          value = opts.hostWaits ? await waitForControl(work) : await work();
        } finally { clearTimeout(hostTimer); inFlight--; }
        const result = JSON.stringify(value) ?? "null";
        if (result.length > 1_000_000) throw new Error("tool result exceeds 1 MB; read a smaller batch");
        return result;
      });
      queue = pending.catch(() => undefined);
      return pending;
    }), new ivm.ExternalCopy(opts.operationNames ?? []).copyInto(),
      new ivm.ExternalCopy(opts.input ?? null).copyInto(), helperMap.derefInto()], { result: { reference: true } });
    const module = await isolate.compileModule(source);
    await module.instantiate(context, () => { throw new Error("imports are not allowed in browser code"); });
    await Promise.race([module.evaluate({ timeout: wallClockMs }), stopped]);
    const run = await module.namespace.get("default", { reference: true });
    if (!run || run.typeof !== "function") throw new Error("export a default async function accepting tools");
    // Serialize and limit the result inside the isolate, before copying it into the host.
    const invoke = await context.eval(`(async function(run, tools) {
      const result = JSON.stringify(await run(tools)) ?? 'null';
      // A number is a host-only size receipt, never an arbitrary guest return value.
      // Drain admitted operations before reporting an oversized return.
      if (result.length > 8000) return result.length;
      return result;
    })`, { reference: true });
    const result = await invoke.apply(undefined, [run.derefInto(), api.derefInto()],
      { timeout: wallClockMs, result: { promise: true, copy: true } });
    await Promise.race([queue, stopped]);
    if (closed) throw new Error("code execution ended");
    if (yielded) return { outcome: "yielded", error: "Resume from acknowledged progress", calls, effectsSettled: true, limit };
    if (typeof result === "number") return { outcome: "error", code: "output_too_large", outputChars: result,
      error: `Return value serialized to ${result} characters; the limit is 8000 including JSON, URLs and element metadata. Operations already executed are not rolled back. Inspect current state before repeating actions.`,
      calls, effectsSettled: true };
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
