import type { RenderClient } from "@tabductor/assets";
import { createTraceRecorder, type BlobStore, type StorageFlags, type TraceRecorder } from "@tabductor/browser";
import { AppError } from "@tabductor/core";
import type { Db, TaskRow } from "@tabductor/db";
import type { RunHandle, RunResult, TaskExecutor } from "@tabductor/engine";
import { createMcpRunClient, loadMcpServers, type McpToolInfo } from "@tabductor/mcp";
import type { PolicyGate } from "@tabductor/policy";
import type { SecretsBrokerHandle } from "@tabductor/secrets";
import type { Metrics } from "@tabductor/telemetry";
import { buildAssetToolRegistry } from "./asset-tools.js";
import {
  asNumber,
  asRecord,
  makeEmitFn,
  maxStepsOf,
  storageFlagsOf as defaultStorageFlagsOf,
  toRunResult,
  triggerInfoOf,
  userIdForTask,
} from "./executor-shared.js";
import type { Llm } from "./llm.js";
import { runAgentLoop } from "./loop.js";

/**
 * The real `(asset, ai)` executor (S5c) — the asset-node mirror of `AgentExecutor`
 * (`executor.ts`), replacing the S5a stub path for tasks whose mode is `ai`. It acquires no
 * browser session: an asset node's "session" is the tool registry (`assets.*` + `mcp.*` +
 * `emit`/`done`/`fail`) plus a trace and this run's MCP connections. Everything else —
 * reading the trigger's schema, the emit dedupe-claim, the step budget, translating
 * `AgentLoopResult` into `RunResult` — is `executor-shared.ts`, shared verbatim with the
 * browser executor rather than re-derived.
 *
 * PRODUCTION code (S5a's `AssetExecutor` in `packages/engine` stays registered for mode
 * `stub`, unchanged — this file does not replace it, `apps/engine/src/main.ts` picks between
 * the two by mode the same way it already picks between `(browser, stub)` and `(browser, ai)`).
 */

export type AssetExecutorDeps = {
  gate: PolicyGate;
  blobs: BlobStore;
  /** For the per-run `TraceRecorder` and the user/MCP-server lookups — the executor does not
   * own a DB connection. */
  db: Db;
  /** Same shape and reasoning as `AgentExecutorDeps.llmFor` — a fresh completion transport
   * per run, wired to that run's own trace recorder. */
  llmFor: (opts: { trace: TraceRecorder; task: TaskRow }) => Llm;
  metrics?: Metrics;
  storageFlagsOf?: (task: TaskRow) => StorageFlags;
  /**
   * Only reached when a configured MCP server names a `secret_name` — omit in a rig where no
   * server needs a credential. The broker is host-side only (§13): nothing in this executor
   * or the tool registry it builds ever sees a plaintext secret, only this narrow
   * `injectIntoMcpArg`/`redeemMcpHandle` pair, which `packages/mcp`'s client is the sole
   * caller of.
   */
  secrets?: Pick<SecretsBrokerHandle, "injectIntoMcpArg" | "redeemMcpHandle">;
  /**
   * S5f wiring: `assets.render`'s HTTP client to `apps/renderer` (S5e), passed straight
   * through to `buildAssetToolRegistry`. Optional for the same reason it is optional there —
   * a rig that never calls `assets.render` (most of S5c's own suite) needs no change here;
   * `apps/engine/src/main.ts` is where production wiring supplies a real one.
   */
  render?: RenderClient;
};

/** `limits_json.mcp` (§13: "per-run call budget... and per-call timeout"). Absent fields let
 * `createMcpRunClient` apply its own defaults (20 calls, 60s) — one default kept in one
 * place, the same convention `maxStepsOf` follows for `limits_json.agent.max_steps`. */
function mcpLimitsOf(task: TaskRow): { maxCalls?: number; callTimeoutMs?: number } {
  const mcp = asRecord(asRecord(task.limitsJson)?.mcp);
  if (!mcp) return {};
  const maxCalls = asNumber(mcp.max_calls);
  const callTimeoutMs = asNumber(mcp.call_timeout_ms);
  return {
    ...(maxCalls !== undefined && maxCalls > 0 ? { maxCalls } : {}),
    ...(callTimeoutMs !== undefined && callTimeoutMs > 0 ? { callTimeoutMs } : {}),
  };
}

function mapAssetError(err: unknown): RunResult {
  if (err instanceof AppError) return { ok: false, error: err.message };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function createAssetExecutor(deps: AssetExecutorDeps): TaskExecutor {
  const { gate, blobs, db, llmFor, metrics, secrets, render } = deps;
  const storageFlagsOf = deps.storageFlagsOf ?? defaultStorageFlagsOf;

  return {
    async execute(handle: RunHandle): Promise<RunResult> {
      const trace = createTraceRecorder(db, blobs, handle.run.id, storageFlagsOf(handle.task));
      const taskCtx = { taskId: handle.task.id, runId: handle.run.id };
      const mcpLimits = mcpLimitsOf(handle.task);
      let mcp: ReturnType<typeof createMcpRunClient> | undefined;

      try {
        const userId = await userIdForTask(db, handle.task.workflowVersionId);
        const [emits, trigger, servers] = await Promise.all([
          handle.declaredEmits(),
          triggerInfoOf(db, handle),
          loadMcpServers(db, userId),
        ]);

        mcp = createMcpRunClient(servers, {
          gate,
          taskCtx,
          runId: handle.run.id,
          trace,
          ...(metrics ? { metrics } : {}),
          ...(secrets ? { secrets } : {}),
          ...mcpLimits,
        });

        // "Every `mcp.<server>.<tool>` this run may call" (asset-tools.ts's own doc comment)
        // needs each server's declared schema before the loop's first turn — the one place
        // this run pays the "lazy connect" cost for every configured server rather than only
        // the ones it ends up calling. A server that never gets an actual `callTool` still
        // gets dialed once, here, for its tool list; §13's per-call budget only counts calls
        // past this point.
        const grantedMcpTools: Array<{ server: string; tool: McpToolInfo }> = (
          await Promise.all(
            servers.map(async (s) => (await mcp!.listTools(s.label)).map((tool) => ({ server: s.label, tool }))),
          )
        ).flat();

        const emit = makeEmitFn({ db, taskId: handle.task.id, handleEmit: handle.emit, trace });
        const tools = buildAssetToolRegistry({
          emit,
          assets: { db, blobs, userId, taskId: handle.task.id, runId: handle.run.id, ...(metrics ? { metrics } : {}) },
          ...(render ? { render } : {}),
          mcp,
          grantedMcpTools,
        });
        const llm = llmFor({ trace, task: handle.task });

        const result = await runAgentLoop({
          llm,
          tools,
          task: { prompt: handle.task.prompt },
          trigger,
          emits,
          trace,
          maxSteps: maxStepsOf(handle.task),
        });
        return toRunResult(result);
      } catch (err) {
        return mapAssetError(err);
      } finally {
        await mcp?.close().catch(() => undefined);
        // No `RunSession.close()` to delegate to here — an asset run's trace flush is this
        // executor's own responsibility (`AgentExecutor`'s `finally` gets this for free from
        // `session.close()`; nothing here owns a session).
        await trace.close().catch(() => undefined);
      }
    },
  };
}
