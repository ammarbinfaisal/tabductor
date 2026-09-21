import type { CheckpointStore } from "./batch-tools.js";
import { z } from "zod";
import { AppError } from "@tabductor/core";
import { runToolScript } from "@tabductor/static-rt";
import type { TraceRecorder } from "@tabductor/browser";
import { defineTool, type AgentTool } from "./tools.js";
import { terminalBrowserError } from "./browser-actions.js";

export function codeTool(tools: AgentTool[], opts: { signal?: AbortSignal; trace?: TraceRecorder;
  progress?: CheckpointStore; beforeCall?: () => Promise<unknown> }): AgentTool {
  const readOnly = /^(?:batch\.read|checkpoint\.get|code\.status|memory\.get|page\.(?:perceive|inspect|find|screenshot|extract|extractBatch|verify)|network\.(?:list|read)|tabs\.list|file\.read)$/;
  const allowed = new Map(tools.filter((tool) => !["done", "fail", "browser.code"].includes(tool.name)).map((tool) => [tool.name, tool]));
  return defineTool({
    name: "browser.code",
    description: "Run bounded JavaScript: export default async function(tools) { ... }. await tools.call(name, args) calls the same validated tools and returns {ok,value,error}; inspect ok, including partial emit.batch acknowledgements. For batch.read: const result = await tools.call('batch.read', {batchId}); if (!result.ok) throw new Error(result.error); const rows = result.value.records; iterate rows, not result.value. Transform/filter/dedupe records in JavaScript, emit.batch with stable keys, checkpoint.set, batch.release, and return a short summary. URL and URLSearchParams are available for parsing and normalization. Up to 50 serialized tool calls, 30 seconds, 32 MB per invocation. Process at most 25 records per batch. Use await tools.budget() for remainingMs/remainingCalls and await tools.yield() to stop admitting calls. Checkpoint acknowledged progress and return before the deadline; automatic yielding stops admission with 5 seconds left. No imports, raw DOM evaluation, filesystem, fetch, or recursive code calls. Page-tool values may be labelled untrusted text; batch.read returns structured records. Return to the agent after any browser error or human takeover; never blindly replay browser writes.",
    parameters: z.object({ source: z.string().min(1).max(24000), timeoutMs: z.number().int().min(1).max(30000).default(30000) }),
    async execute(args, callSignal) {
      const signal = opts.signal && callSignal ? AbortSignal.any([opts.signal, callSignal]) : opts.signal ?? callSignal;
      const previous = await opts.progress?.get() as { inFlight?: { tool?: string }; requiresReconciliation?: boolean } | null;
      if (previous?.inFlight?.tool && readOnly.test(previous.inFlight.tool)) {
        await opts.progress?.set({ ...previous, inFlight: null });
        return { ok: false, error: "A previous observation was interrupted. Reacquire page and batch handles, read checkpoint.get, then continue." };
      }
      if (previous?.inFlight) throw new AppError("resource_limit_exceeded", "Previous code effect remains uncertain; reconcile its destination before restarting this run");
      if (previous?.requiresReconciliation) return { ok: false, error: "An earlier browser effect has an uncertain outcome. Inspect the destination and use page.verify to reconcile it before running more code." };
      const acknowledgements: Array<{ tool: string; result: unknown }> = [];
      let interrupted = false;
      let fatal: AppError | undefined;
      const result = await runToolScript(args.source, async (name, input, signal, waitForControl) => {
        signal.throwIfAborted(); opts.signal?.throwIfAborted();
        if (interrupted) throw new Error("browser changed or a page tool failed; return control to the agent");
        if (await waitForControl(async () => opts.beforeCall?.())) { interrupted = true; throw new Error("human takeover changed the browser; discard old actions and return control"); }
        signal.throwIfAborted();
        const tool = allowed.get(name);
        if (!tool) throw new Error(`tool ${name} is not available inside browser.code`);
        await opts.progress?.set({ ...await opts.progress.get() as object, inFlight: { tool: name, startedAt: new Date().toISOString() }, acknowledgements });
        let value;
        try { value = await tool.execute(input, signal); } catch (error) {
          if (error instanceof AppError && terminalBrowserError(error) && !["browser_input_revoked", "browser_fresh_perception_required"].includes(error.code)) fatal = error;
          interrupted = true;
          // Ownership rejection is known to occur before dispatch. Other thrown errors
          // leave the journal pending until their effects are reconciled.
          if (readOnly.test(name) || error instanceof AppError && ["browser_input_revoked", "browser_fresh_perception_required", "agent_no_progress", "human_action_pending"].includes(error.code)) {
            await opts.progress?.set({ ...await opts.progress.get() as object, inFlight: null, acknowledgements });
          }
          throw error;
        }
        const summary = ["emit", "emit.batch", "checkpoint.set", "record.outcome"].includes(name) ? value : { ok: value.ok };
        acknowledgements.push({ tool: name, result: JSON.stringify(summary).slice(0, 1000) });
        if (acknowledgements.length > 6) acknowledgements.shift();
        await opts.progress?.set({ ...await opts.progress.get() as object, inFlight: null, acknowledgements, requiresReconciliation: value.outcomeUncertain === true && /^page\.(?:click|type|press|select|drag|upload|goto)/.test(name) });
        if (!value.ok && name.startsWith("page.")) interrupted = true;
        await opts.trace?.record("action", { action: "tool.call", tool: name, source: "browser.code", ok: value.ok });
        return value;
      }, { signal, wallClockMs: args.timeoutMs, maxCalls: 50, yieldBeforeMs: Math.min(5000, args.timeoutMs / 5) });
      await opts.trace?.record("action", { action: "browser.code", outcome: result.outcome, calls: result.calls, ...(result.outcome !== "completed" ? { limit: result.limit, effectsSettled: result.effectsSettled } : {}) });
      if (fatal) throw fatal;
      if (result.outcome === "yielded" || result.outcome === "killed" && result.effectsSettled && result.limit === "wall_clock") {
        const journal = await opts.progress?.get() as { inFlight?: { tool?: string }; requiresReconciliation?: boolean } | null;
        if (!journal?.inFlight) return { ok: true, value: { outcome: "yielded", reason: result.limit, acknowledgements,
          next: "Read checkpoint.get and continue with the next bounded batch; never replay acknowledged writes." } };
      }
      if (result.outcome === "killed") throw new AppError("resource_limit_exceeded", "browser code exceeded its time or memory limit; reconcile acknowledged effects before retrying");
      return result.outcome === "completed" ? { ok: true, value: result.value }
        : { ok: false, error: result.error };
    },
  });
}
