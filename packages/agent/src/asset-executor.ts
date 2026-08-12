import type { RenderClient } from "@tabductor/assets";
import type { Pool } from "pg";
import { createTraceRecorder, type BlobStore, type StorageFlags, type TraceRecorder } from "@tabductor/browser";
import { AppError } from "@tabductor/core";
import { workflows, workflowVersions, type Db, type TaskRow } from "@tabductor/db";
import { eq } from "drizzle-orm";
import type { RunHandle, RunResult, TaskExecutor } from "@tabductor/engine";
import { createMcpRunClient, loadMcpServers, type McpToolInfo } from "@tabductor/mcp";
import type { PolicyGate } from "@tabductor/policy";
import type { SecretsBrokerHandle } from "@tabductor/secrets";
import {
  createStoreInsertTool,
  createStoreQueryTool,
  createStoreUpsertTool,
  createWriteStager,
  flushStagedWrites,
  latestStoreSchema,
  tablesSpecOf,
  type StoreTool,
} from "@tabductor/store";
import type { Metrics } from "@tabductor/telemetry";
import { buildAssetToolRegistry } from "./asset-tools.js";
import {
  asNumber,
  asRecord,
  flushRemainingWrites,
  makeEmitFn,
  maxStepsOf,
  storageFlagsOf as defaultStorageFlagsOf,
  toRunResult,
  triggerInfoOf,
} from "./executor-shared.js";
import type { AgentTool, ToolResult } from "./tools.js";
import type { Llm } from "./llm.js";
import { runAgentLoop } from "./loop.js";

/** `StoreTool` (`@tabductor/store`) is structurally identical to `AgentTool` (`tools.ts`) by
 * the same convention `asset-tools.ts`'s own `assetToolToAgentTool` documents — a wrap, not a
 * shared base type, since `@tabductor/store` cannot import `@tabductor/agent` (the dependency
 * would cycle: `@tabductor/agent` already depends on `@tabductor/store` for this file). */
function storeToolToAgentTool(t: StoreTool): AgentTool {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    async execute(args): Promise<ToolResult> {
      return t.execute(args);
    },
  };
}

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
  /**
   * S5g: `store.query/insert/upsert`'s connection to the fenced read/write paths
   * (`@tabductor/store`'s `runStoreQuery`/`flushStagedWrites` both need a raw `pg.Pool`, not
   * the Drizzle `Db` — see that package's own doc comment on why). Optional so every rig that
   * predates S5g keeps compiling and running unchanged: with it omitted, an asset run's
   * registry has no `store.*` tools at all, exactly the S5c-era shape.
   */
  pool?: Pool;
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

/**
 * A `RunHandle` carries `task.workflow_version_id`, not `user_id` directly — asset tools and
 * the MCP server lookup are both scoped by user (§13.5, §13: "MCP servers... configured per
 * user"), and the store is scoped by workflow, so this join resolves both at once. The shared
 * `userIdForTask` (`executor-shared.ts`) does the user half for the browser executor, which
 * needs no workflow id; this asset-side helper returns both because the store tools do.
 */
async function workflowForTask(db: Db, workflowVersionId: string): Promise<{ userId: string; workflowId: string }> {
  const rows = await db
    .select({ userId: workflows.userId, workflowId: workflows.id })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(workflowVersions.id, workflowVersionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new AppError("asset_task_workflow_not_found", `no workflow found for workflow_version ${workflowVersionId}`, {
      details: { workflowVersionId },
    });
  }
  return row;
}

function mapAssetError(err: unknown): RunResult {
  if (err instanceof AppError) return { ok: false, error: err.message };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function createAssetExecutor(deps: AssetExecutorDeps): TaskExecutor {
  const { gate, blobs, db, llmFor, metrics, secrets, render, pool } = deps;
  const storageFlagsOf = deps.storageFlagsOf ?? defaultStorageFlagsOf;

  return {
    async execute(handle: RunHandle): Promise<RunResult> {
      const trace = createTraceRecorder(db, blobs, handle.run.id, storageFlagsOf(handle.task));
      const taskCtx = { taskId: handle.task.id, runId: handle.run.id };
      const mcpLimits = mcpLimitsOf(handle.task);
      let mcp: ReturnType<typeof createMcpRunClient> | undefined;
      // S5g: staged store.insert/upsert writes, drained and committed atomically with this
      // run's next `emit` (`makeEmitFn`'s `drainPendingWrites`/`wrapPendingWrites`) or, absent
      // one, flushed once at the very end (`flushRemainingWrites`).
      const stager = createWriteStager();

      try {
        const { userId, workflowId } = await workflowForTask(db, handle.task.workflowVersionId);
        const [emits, trigger, servers, storeSchema] = await Promise.all([
          handle.declaredEmits(),
          triggerInfoOf(db, handle),
          loadMcpServers(db, userId),
          latestStoreSchema(db, workflowId),
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

        const emit = makeEmitFn({
          db,
          taskId: handle.task.id,
          handleEmit: handle.emit,
          trace,
          ...(pool
            ? {
                drainPendingWrites: () => stager.drain(),
                wrapPendingWrites: (writes) => flushStagedWrites(workflowId, writes),
              }
            : {}),
        });
        const tools = buildAssetToolRegistry({
          emit,
          assets: { db, blobs, userId, taskId: handle.task.id, runId: handle.run.id, ...(metrics ? { metrics } : {}) },
          ...(render ? { render } : {}),
          mcp,
          grantedMcpTools,
        });
        // §4/ROADMAP.md: "kind=asset gets... store.query/insert/upsert" — added onto the
        // registry `buildAssetToolRegistry` (`asset-tools.ts`, S5f territory) returns, rather
        // than inside it, so this file stays the only one that needs to know `@tabductor/store`
        // exists. Omitted entirely when `pool` is not configured (a rig that predates S5g).
        if (pool) {
          const tablesSpec = tablesSpecOf(storeSchema);
          const writeDeps = { db, workflowId, taskId: handle.task.id, tablesSpec, stager };
          tools.push(
            storeToolToAgentTool(createStoreQueryTool({ pool, workflowId, ...(metrics ? { metrics } : {}) })),
            storeToolToAgentTool(createStoreInsertTool(writeDeps)),
            storeToolToAgentTool(createStoreUpsertTool(writeDeps)),
          );
        }
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

        // The safety net for a run that staged a write and then finished with no further
        // `emit` to ride — only on `done`: a run that fails or exhausts its step budget drops
        // whatever it staged rather than force-committing a side effect from an incomplete
        // attempt (a retry re-stages it if the corrected attempt still wants it).
        if (pool && result.outcome === "done") {
          await flushRemainingWrites({
            db,
            drainPendingWrites: () => stager.drain(),
            wrapPendingWrites: (writes) => flushStagedWrites(workflowId, writes),
          });
        }
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
