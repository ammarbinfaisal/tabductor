import { randomUUID } from "node:crypto";
import { asSchema } from "ai";
import { z } from "zod";
import { AppError } from "@tabductor/core";
import { runToolScript, type HelperRevision, type SdkTerminal } from "@tabductor/static-rt";
import type { TraceRecorder, StorageFlags } from "@tabductor/browser";
import type { CheckpointStore } from "./batch-tools.js";
import { validateHelperSource, type BrowserHelperStore } from "./browser-helpers.js";
import { defineTool, type AgentTool, type ToolImage, type ToolResult } from "./tools.js";
import { terminalBrowserError } from "./browser-actions.js";
import { CODE_OUTPUT_GUIDANCE, compactCodeObservation, pythonOutputPreview } from "./code-output.js";
import type { PythonRunner } from "./python-runner.js";
import type { RunWorkspace } from "./workspace.js";
import type { ContextHistory } from "./context-history.js";
import { PYTHON_BROWSER_GUIDANCE, sdkCatalog } from "./python-guidance.js";

export type BrowserCodeOptions = {
  signal?: AbortSignal; trace?: TraceRecorder; progress?: CheckpointStore;
  beforeCall?: () => Promise<unknown>; input?: unknown; helpers?: BrowserHelperStore;
  compiled?: boolean; pinnedHelpers?: HelperRevision[];
  target?: (anchor: string) => string | undefined;
  sensitive?: (anchor: string) => boolean;
  sensitiveOperation?: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  storageFlags?: StorageFlags;
  memoryMb?: number;
  pythonRunner?: PythonRunner;
  workspace?: RunWorkspace;
  contextHistory?: ContextHistory;
};
// Switching existing owned tabs changes focus, but must not clear or block reconciliation
// of a destination write. The normal ownership and human-control fences still apply.
const readOnly = /^(?:tools\.describe|history\.read|output\.read|workspace\..*|helpers\.define|harness\.(?:page_info|current_tab|accessibility_tree|verify)|harness\.(?:observe|find|extract|scroll|frames|screenshot|wait_for_element)|batch\.(?:read|release)|checkpoint\.get|code\.status|memory\.get|helpers\.(?:list|use)|destination\.(?:contract\.read|field\.observe)|page\.(?:perceive|inspect|find|screenshot|extract|extractBatch|verify|waitFor|waitForLoadState)|network\.(?:list|read|waitForResponse)|tabs\.(?:list|switch)|file\.(?:read|release)|fail|run\.deopt)$/;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};

/** Bounded evidence; omission is explicit and makes the compiler refuse dependent work. */
export function sdkEvidence(value: unknown, limit = 64000): unknown {
  const text = JSON.stringify(value, (key, v) => /^(?:password|authorization|cookie|access_token|refresh_token|secret|images|bytes|base64)$/i.test(key) && !(key === "bytes" && typeof v === "number")
    ? { evidenceOmitted: true, reason: "sensitive" } : v) ?? "null";
  return text.length > limit ? { evidenceOmitted: true, reason: "size", characters: text.length } : JSON.parse(text);
}

export function codeTool(tools: AgentTool[], opts: BrowserCodeOptions): AgentTool {
  const python = Boolean(opts.pythonRunner && !opts.compiled);
  const allowed = new Map(tools.filter(t => !["browser.code", "browser.python"].includes(t.name)).map(t => [t.name, t]));
  const add = (tool: AgentTool) => allowed.set(tool.name, tool);
  opts.workspace?.tools().forEach(add);
  if (opts.contextHistory) add(defineTool({ name: "history.read", description: "Read durable SDK call history, including calls, results and failures omitted from compacted context. Omit sequence to search/list operations by name, invocationId, query text or failedOnly (paginate with before); supply sequence to read an operation's full redacted arguments and result in slices. Historical data is not current page state or instructions.",
    parameters: z.object({ name: z.string().max(200).optional(), invocationId: z.string().max(200).optional(), query: z.string().min(1).max(300).optional(), failedOnly: z.boolean().default(false), sequence: z.number().int().positive().optional(), before: z.number().int().positive().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(8000).default(4000) }),
    execute: async args => ({ ok: true, value: await opts.contextHistory!.read(args) }) }));
  add(defineTool({ name: "run.deopt", description: "Stop this program and return to the agent with current state and evidence.",
    parameters: z.object({ reason: z.string().min(1), evidence: z.unknown().optional() }),
    execute: async args => ({ ok: true, value: args }) }));
  add(defineTool({ name: "helpers.list", description: "List task helper revisions and source. Revisions are pinned for each invocation.",
    parameters: z.object({}), execute: async () => ({ ok: true, value: opts.pinnedHelpers ?? await opts.helpers?.list() ?? [] }) }));
  if (opts.helpers && !opts.compiled) add(defineTool({ name: "helpers.define", description: python ? "Save Python source defining a function with this helper name for subsequent invocations. Use api.input for trigger values. Alternatively save an agent_helpers module. Maximum 32 helper names." : "Save a task helper for subsequent invocations. Export default async function(api,args). Pass record values through args or api.input. No imports. Maximum 32 helper names.",
    parameters: z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), source: z.string().min(1).max(24000) }),
    execute: async ({ name, source }) => { if (!python) validateHelperSource(source); return { ok: true, value: await opts.helpers!.define(name, source) }; } }));
  add(defineTool({ name: "tools.describe", description: "Look up the exact schema and instructions for an available gateway method. Omit name for the compact catalog.",
    parameters: z.object({ name: z.string().optional() }),
    execute: async ({ name }) => {
      if (!name) return { ok: true, value: { catalog: sdkCatalog(allowed.values()) } };
      const tool = allowed.get(name.replace(/^api\./, "").replace(/^run\.(done|fail)$/, "$1"));
      return tool ? { ok: true, value: { name: tool.name, description: tool.description, parameters: asSchema(tool.parameters).jsonSchema } }
        : { ok: false, error: `Unknown method: ${name}. Call api.tools.describe() for available methods.` };
    } }));
  const docs = python ? sdkCatalog(allowed.values()) : [...allowed.values()].map(t => `${t.name === "done" || t.name === "fail" ? "run." : ""}${t.name}(${JSON.stringify(asSchema(t.parameters).jsonSchema)}): ${t.description}`).join("\n");
  return defineTool({
    name: python ? "browser.python" : "browser.code",
    description: python ? `${PYTHON_BROWSER_GUIDANCE}\nAvailable gateway methods:\n${docs}` : `Execute export default async function(api) { ... }. This is the only browser tool. SDK methods take one object and return {ok,value,error}; check ok. api.input contains the current trigger packet (never copy example values into reusable programs). Use fresh observation anchors after actions. api.helpers.call(name,args) runs a pinned helper in this isolate. api.run.done({result}) and api.run.fail({reason}) finish the task; ordinary return only ends this invocation. api.run.deopt({reason,evidence}) returns control to the agent. Return a short observation/summary and checkpoint durable progress; JavaScript variables do not survive calls. Screenshots are attached automatically. api.budget()/api.yield() bound batches. 32 MB, 50 operations, 30 seconds of guest execution; host operations have separate bounded waits. No imports, filesystem, fetch, raw DOM evaluation, or recursive browser.code. The SDK retains the existing policy, verification, cancellation and takeover fences. Inspect uncertain effects before choosing the next action and avoid duplicate writes; AI exploration remains available. Verification helpers are optional in AI mode, while static execution requires machine-checked guards.\n${CODE_OUTPUT_GUIDANCE}\nAvailable SDK methods:\n${docs}`,
    parameters: z.object({ source: z.string().min(1).max(24000), timeoutMs: z.number().int().min(1).max(python ? 180000 : 30000).default(python ? 180000 : 30000) }),
    async execute(args, callSignal) {
      const signal = opts.signal && callSignal ? AbortSignal.any([opts.signal, callSignal]) : opts.signal ?? callSignal;
      const invocationId = randomUUID();
      const helpers = opts.pinnedHelpers ?? await opts.helpers?.list() ?? [];
      const images: ToolImage[] = [];
      const usedHelpers = new Set<string>();
      let terminal: SdkTerminal | undefined;
      const sdkCalls = new Map<number, { name: string; args: unknown; parent?: number; sensitive: boolean; effect: boolean }>();
      let interrupted = false, sensitive = false, sequence = 0;
      let fatal: unknown;
      let lastOperation: { tool: string; ok: boolean; code?: string; error?: string; dispatch?: string; outcomeUncertain?: boolean } | undefined;
      let lastObservation: Record<string, unknown> | undefined;
      const previous = object(await opts.progress?.get());
      if (previous.inFlight) {
        const interruptedRead = readOnly.test(String(object(previous.inFlight).tool));
        await opts.progress?.set({ ...previous, inFlight: null, requiresReconciliation: !interruptedRead || previous.requiresReconciliation === true,
          ...(interruptedRead ? {} : { uncertainOperation: previous.inFlight }) });
      }
      const result = await (python ? opts.pythonRunner! : runToolScript)(args.source, async (name, input, operationSignal, waitForControl, context) => {
        operationSignal.throwIfAborted(); signal?.throwIfAborted();
        if ((terminal || interrupted && name !== "run.deopt") && !name.startsWith("workspace.") && name !== "helpers.define") throw new Error("Program stopped; return to the agent before issuing more operations");
        try {
          if (await waitForControl(async () => opts.beforeCall?.())) { interrupted = true; throw new Error("Browser control changed; reacquire observations in a new invocation"); }
        } catch (error) {
          if (terminalBrowserError(error)) fatal = error;
          throw error;
        }
        const tool = allowed.get(name);
        const helper = name === "helpers.use" && helpers.find(h => h.name === object(input).name && h.revision === object(input).revision);
        if (helper) usedHelpers.add(helper.name);
        const effect = !readOnly.test(name) && !(name === "harness.request" && object(input).semantics === "read");
        const progress = object(await opts.progress?.get());
        const operationId = randomUUID(), started = Date.now();
        const anchor = String(object(input).anchor ?? "");
        const isSensitive = name === "secrets.fill" || Boolean(anchor && opts.sensitive?.(anchor)) ||
          name.startsWith("network.") && opts.storageFlags?.network === false ||
          await opts.sensitiveOperation?.(name, object(input)) === true;
        sensitive ||= isSensitive;
        for (let id = context?.sdkCallId; id !== undefined;) {
          const sdk = sdkCalls.get(id);
          if (!sdk) break;
          sdk.sensitive ||= isSensitive || opts.storageFlags?.actions === false;
          sdk.effect ||= effect;
          id = sdk.parent;
        }
        const entry = { operationId, invocationId, sequence: sequence++, name, effect, target: anchor ? opts.target?.(anchor) : undefined,
          ...(context?.sdkCallId ? {sdkCallId:context.sdkCallId} : {}),
          ...(context?.parent ? { parentHelper: context.parent } : {}) };
        const argsEvidence = isSensitive ? {evidenceOmitted:true,reason:"sensitive"} : sdkEvidence(input,64_000_000);
        const argsBytes = Buffer.from(JSON.stringify(argsEvidence));
        const remember = async (result: unknown) => opts.contextHistory?.append({ operationId, invocationId, name, effect, layer: "gateway",
          ...(context?.sdkCallId ? { sdkCallId: context.sdkCallId } : {}),
          ...(context?.parent ? { parentHelper: sdkEvidence(context.parent) } : {}),
          args: isSensitive || opts.storageFlags?.actions === false ? { evidenceOmitted: true, reason: "sensitive" } : argsEvidence,
          result: isSensitive || opts.storageFlags?.actions === false ? { evidenceOmitted: true, reason: "sensitive", ok: object(result).ok,
            code: object(result).code, outcomeUncertain: object(result).outcomeUncertain } : sdkEvidence(result, 64_000_000) });
        await opts.trace?.record("action", { action: "sdk.operation", ...entry, phase: "started", args: argsBytes.length > 64000 ? {evidenceOmitted:true,reason:"artifact"} : argsEvidence },
          argsBytes.length > 64000 ? {kind:"actions",bytes:argsBytes,mime:"application/json"} : undefined);
        const rejected = !tool && !helper ? { ok: false, error: `SDK operation unavailable: ${name}` } :
          opts.compiled && effect && progress.requiresReconciliation ? { ok: false, code: "reconciliation_required", outcomeUncertain: false,
            error: "An earlier browser action may have executed. Inspect its outcome before further actions: use page.verify for navigation or login postconditions, or verify the exact destination record for a write. Do not replay the uncertain action." } : undefined;
        if (rejected) {
          await remember(rejected);
          await opts.trace?.record("action", { action: "sdk.operation", ...entry, phase: "finished", result: rejected, durationMs: Date.now()-started });
          if (!tool && !helper) throw new Error(rejected.error);
          return rejected;
        }
        if (!opts.compiled && effect && progress.requiresReconciliation) {
          await opts.trace?.record("runtime", {action:"ai.uncertain_effect",invocationId,operationId,name,
            guidance:"An earlier action may have executed. Inspect its outcome and avoid duplicate writes; AI exploration remains available."});
        }
        if (effect) {
          await opts.progress?.set({ ...progress, inFlight: { operationId, tool: name, startedAt: new Date().toISOString() } });
          await opts.trace?.flush();
        }
        let value: ToolResult;
        lastObservation = undefined;
        try {
          value = helper ? { ok: true, value: { name: helper.name, revision: helper.revision } } : await tool!.execute(input, operationSignal);
        } catch (error) {
          interrupted = opts.compiled === true || terminalBrowserError(error);
          if (terminalBrowserError(error) && !(error instanceof AppError && ["browser_input_revoked", "browser_fresh_perception_required"].includes(error.code))) fatal = error;
          const rejected = error instanceof AppError && ["browser_input_revoked", "browser_fresh_perception_required", "agent_no_progress"].includes(error.code) && !error.details?.actionExecuted;
          const current = object(await opts.progress?.get());
          if (effect) await opts.progress?.set({ ...current, inFlight: null, requiresReconciliation: current.requiresReconciliation === true || !rejected, uncertainOperation: rejected ? current.uncertainOperation ?? null : { operationId, tool: name } });
          await opts.trace?.record("action", { action: "sdk.operation", ...entry, phase: "finished", error: isSensitive ? "Sensitive operation failed" : String(error).slice(0,1000), durationMs: Date.now()-started });
          await remember({ ok: false, error: String(error).slice(0, 4000), outcomeUncertain: effect && !rejected,
            ...(error instanceof AppError ? { code: error.code } : {}) });
          throw error;
        }
        operationSignal.throwIfAborted(); signal?.throwIfAborted();
        if (value.images) images.splice(0, images.length, ...value.images);
        const { images: _images, ...data } = value;
        await remember(data);
        lastOperation = { tool: name, ok: value.ok, code: value.code, dispatch: value.action?.dispatch,
          outcomeUncertain: value.outcomeUncertain, ...(!value.ok ? { error: value.error.slice(0, 200) } : {}) };
        lastObservation = compactCodeObservation(value.value) ?? compactCodeObservation(object(value.value).perception);
        const evidence = isSensitive ? { ok: value.ok, evidenceOmitted: true } : sdkEvidence(data, 64_000_000);
        const bytes = Buffer.from(JSON.stringify(evidence));
        const offload = bytes.length > 64000;
        await opts.trace?.record("action", { action: "sdk.operation", ...entry, phase: "finished",
          result: offload ? { evidenceOmitted: true, reason: "artifact", bytes: bytes.length } : evidence,
          durationMs: Date.now()-started }, offload ? { kind:"actions", bytes, mime:"application/json" } : undefined);
        const current = object(await opts.progress?.get());
        const uncertain = value.outcomeUncertain === true || value.action?.dispatch === "uncertain";
        if (effect) await opts.progress?.set({ ...current, inFlight: null, requiresReconciliation: uncertain || current.requiresReconciliation === true,
          lastAcknowledgedOperation: uncertain ? current.lastAcknowledgedOperation : operationId,
          uncertainOperation: uncertain ? { operationId, tool: name } : current.uncertainOperation ?? null });
        if (value.ok && ["page.verify", "harness.verify"].includes(name)) await opts.progress?.set({ ...object(await opts.progress?.get()), requiresReconciliation: false, uncertainOperation: null });
        if (value.ok && name === "done") terminal = { outcome: "done", result: value.value };
        if (value.ok && name === "fail") terminal = { outcome: "fail", reason: String(value.value) };
        if (value.ok && name === "run.deopt") terminal = { outcome: "deopt", reason: String(object(value.value).reason), evidence: object(value.value).evidence };
        if (opts.compiled && !value.ok && name.startsWith("page.")) interrupted = true;
        return data;
      }, { signal, wallClockMs: args.timeoutMs, maxCalls: python || opts.compiled ? 1000 : 50, yieldBeforeMs: Math.min(5000,args.timeoutMs/5), hostWaits: true,
        operationNames: [...allowed.keys()], input: opts.input, helpers, memoryMb: opts.memoryMb,
        workspace: opts.workspace, onSdkCall: async (event: unknown) => {
          const call = object(event);
          if (typeof call.sdkCallId === "number" && call.phase === "started") sdkCalls.set(call.sdkCallId, {
            name: String(call.name), args: { args: call.args, kwargs: call.kwargs },
            parent: typeof call.parent === "number" ? call.parent : undefined,
            sensitive: opts.storageFlags?.actions === false, effect: false,
          });
          const sdk = typeof call.sdkCallId === "number" ? sdkCalls.get(call.sdkCallId) : undefined;
          if (sdk && call.phase === "finished") {
            const redacted = { evidenceOmitted: true, reason: "sensitive" };
            await opts.contextHistory?.append({ operationId: `${invocationId}:sdk:${call.sdkCallId}`, invocationId,
              name: sdk.name, layer: "python-sdk", sdkCallId: Number(call.sdkCallId), effect: sdk.effect,
              args: sdk.sensitive ? redacted : sdkEvidence(sdk.args, 64_000_000),
              result: sdk.sensitive ? { ...redacted, ok: call.error === undefined } : sdkEvidence({ ok: call.error === undefined,
                ...(call.error === undefined ? { value: call.result } : { error: call.error }) }, 64_000_000) });
            sdkCalls.delete(Number(call.sdkCallId));
          }
          const evidence = sdkEvidence(event,64_000_000);
          const bytes = Buffer.from(JSON.stringify(evidence));
          await opts.trace?.record("action", {action:"harness.sdk",invocationId,...(bytes.length<=64000 ? object(evidence) : {evidenceOmitted:true,reason:"artifact"})},
            bytes.length>64000 ? {kind:"actions",bytes,mime:"application/json"} : undefined);
        }, onOutput: async (output: string) => {
          if (opts.storageFlags?.actions !== false) await opts.workspace?.saveOutput(invocationId,output);
          await opts.trace?.record("action", {action:"python.output",invocationId,characters:output.length,preview:pythonOutputPreview(output).output},
            {kind:"actions",bytes:Buffer.from(output),mime:"text/plain"});
        } });
      await opts.trace?.record("action", { action: "sdk.invocation", invocationId, language: python ? "python" : "javascript", operationVersion: 2, source: sensitive ? undefined : args.source,
        evidenceOmitted: sensitive, input: sensitive ? undefined : sdkEvidence(opts.input), helpers: sensitive ? undefined : helpers.filter(h=>usedHelpers.has(h.name)),
        api: [...allowed.values()].map(t => ({ name: t.name, parameters: asSchema(t.parameters).jsonSchema })),
        outcome: terminal?.outcome ?? result.outcome, ...(result.outcome === "error" ? {error:sensitive ? "Sensitive invocation failed" : result.error} : {}), calls: result.calls, compiled: opts.compiled === true,
        ...(result.outcome === "error" && result.code ? { code: result.code, outputChars: result.outputChars } : {}) });
      await opts.trace?.record("action", { action: python ? "browser.python" : "browser.code", outcome: terminal?.outcome ?? result.outcome, calls: result.calls });
      if (fatal) throw fatal;
      if (python && terminal && result.outcome !== "completed") return {ok:false,error:result.error};
      if (terminal) return { ok: true, value: { outcome: terminal.outcome }, terminal, ...(images.length ? { images } : {}) };
      if (result.outcome === "killed") throw new AppError("resource_limit_exceeded", "Browser program exceeded its execution limit; inspect its journal before retrying");
      if (result.outcome === "yielded") return { ok: true, value: { outcome: "yielded", next: "Continue from checkpoint and acknowledged effects" }, ...(images.length ? {images} : {}) };
      if (result.outcome === "error" && result.code === "output_too_large") return {
        ok: false, code: result.code, error: result.error,
        value: { outputChars: result.outputChars, limitChars: 8000, calls: result.calls,
          lastOperation, observation: lastObservation,
          next: "Continue from acknowledged operations. Do not rerun this program or repeat writes just to shorten its return. Inspect current state with a new read-only program and return selected fields." },
        ...(images.length ? { images } : {}),
      };
      return result.outcome === "completed" ? { ok: true, value: python ? {...object(result.value),invocationId} : result.value, ...(images.length ? {images} : {}) } : { ok: false, error: result.error, ...(python ? {value:{invocationId}} : {}), ...(images.length ? {images} : {}) };
    },
  });
}
