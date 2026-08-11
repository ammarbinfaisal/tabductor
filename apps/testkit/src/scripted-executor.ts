import {
  createTraceRecorder,
  openRunSession,
  type BlobStore,
  type EndpointLease,
  type EndpointPool,
  type NetworkListRecord,
  type Page,
  type ResourceLimits,
  type StorageFlags,
} from "@tabductor/browser";
import { AppError } from "@tabductor/core";
import type { Db, TaskRow } from "@tabductor/db";
import type { RunHandle, RunResult, TaskExecutor } from "@tabductor/engine";
import type { PolicyGate } from "@tabductor/policy";
import type { Metrics } from "@tabductor/telemetry";
import { z } from "zod";

/**
 * The test-only executor for task mode `scripted` (S3b deliverable 6): it reads a fixed
 * JSON action list off `tasks.limits_json.script` and drives it through the real
 * pool/gate/session/trace stack. This is the harness that lets the engine, the endpoint
 * pool, and the browser layer be exercised *together* before an agent (Phase 4) exists to
 * decide its own actions or a compiler (Phase 6) exists to emit a static program — it is
 * neither of those things, and nothing here anticipates their shape.
 *
 * Lives in `apps/testkit` per the subphase doc. `tasks.mode` is not a closed set
 * (`graph.ts`'s `graphTaskSchema.mode` is a bare `z.string()`), so registering `"scripted"`
 * needs no schema change anywhere — a test seeds a task with `mode: "scripted"` through
 * `seedWorkflow` exactly as it seeds `"stub"`, then calls `updateTask` to attach the actual
 * script (`SeedTask` has no generic `limits` escape hatch, and adding one would be a wider
 * change than one field's worth of test convenience justifies).
 */

const fieldSpecSchema = z.object({ selector: z.string().optional(), attr: z.string().optional() });
const extractSpecSchema = z.record(fieldSpecSchema);

/** Which of the script's own past observations becomes an `emit`'s packet — see `packetFor`. */
const packetFromSchema = z.enum(["lastExtract", "lastNetworkList", "lastNetworkBody"]);

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.string().min(1) }),
  z.object({ action: z.literal("click"), selector: z.string().min(1) }),
  z.object({
    action: z.literal("waitFor"),
    selector: z.string().min(1),
    timeoutMs: z.number().positive().optional(),
  }),
  z.object({ action: z.literal("extract"), selector: z.string().min(1), fields: extractSpecSchema }),
  z.object({ action: z.literal("openTab") }),
  z.object({ action: z.literal("networkList"), urlPattern: z.string().optional() }),
  z.object({
    action: z.literal("networkBody"),
    // Either resolves the record directly; `urlPattern` is the ergonomic one for a script
    // that doesn't want to hardcode an index it would have to compute from `networkList`
    // itself — it takes the first record `networkList({ urlPattern })` would return.
    index: z.number().int().nonnegative().optional(),
    urlPattern: z.string().optional(),
  }),
  z.object({ action: z.literal("emit"), type: z.string().min(1), packetFrom: packetFromSchema.optional() }),
]);

export type ScriptAction = z.infer<typeof actionSchema>;

const browserLimitsSchema = z.object({
  max_tabs: z.number().int().positive().optional(),
  max_visits: z.number().int().positive().optional(),
  max_wall_ms: z.number().positive().optional(),
});

const storageFlagsSchema = z.object({
  navigations: z.boolean().optional(),
  actions: z.boolean().optional(),
  network: z.boolean().optional(),
  screenshots: z.boolean().optional(),
  llm: z.boolean().optional(),
});

const limitsJsonSchema = z.object({
  script: z.array(actionSchema).default([]),
  browser: browserLimitsSchema.optional(),
  storage: storageFlagsSchema.optional(),
});

type ParsedLimits = { script: ScriptAction[]; browser: ResourceLimits | undefined; storage: StorageFlags };

/**
 * `limits_json.script`/`.browser`/`.storage` in one parse. Unknown keys (`retry`,
 * `run_timeout_ms`, …) pass through untouched — `updateTask` replaces the whole column, so a
 * test that wants both a retry policy and a script writes both into the same call, and this
 * parser has no business objecting to the ones it doesn't read. Malformed config *is* this
 * parser's business: it is a test author's mistake, not a browser fault, so it throws rather
 * than quietly degrading to an empty script.
 */
function parseLimits(limitsJson: unknown): ParsedLimits {
  const parsed = limitsJsonSchema.safeParse(limitsJson);
  if (!parsed.success) {
    throw new AppError(
      "scripted_config_invalid",
      `limits_json does not match the scripted executor's schema: ${parsed.error.message}`,
      { details: { issues: parsed.error.issues } },
    );
  }
  return {
    script: parsed.data.script,
    browser: parsed.data.browser
      ? {
          maxTabs: parsed.data.browser.max_tabs,
          maxVisits: parsed.data.browser.max_visits,
          maxWallMs: parsed.data.browser.max_wall_ms,
        }
      : undefined,
    storage: parsed.data.storage ?? {},
  };
}

export type ScriptedExecutorDeps = {
  pool: EndpointPool;
  gate: PolicyGate;
  blobs: BlobStore;
  /** For the per-run `TraceRecorder` — the executor does not own a connection to the DB. */
  db: Db;
  /**
   * Which endpoint every run acquires. The simplest honest choice available: there is no
   * per-task or per-user endpoint assignment model yet (that does not exist before this
   * phase), so one explicitly-injected id stands in for "the endpoint this harness talks
   * to" — the same role a single local Chrome instance already plays for `openSession` in
   * the Phase 3 system tests. (The alternative the subphase doc names, "the first
   * `cdp_endpoints` row", would make endpoint choice an implicit DB scan instead of a
   * declared dependency — a worse trade for a harness whose whole point is legibility.)
   */
  defaultEndpointId: string;
  /** Defaults to `limits_json.storage`, mirroring how `.browser` is read — injectable so a
   * test can force a flag off without writing a task row for it. */
  storageFlagsOf?: (task: TaskRow) => StorageFlags;
  metrics?: Metrics;
};

type ScriptState = {
  currentPage: Page;
  lastExtract?: Awaited<ReturnType<Page["queryAll"]>>;
  lastNetworkList?: NetworkListRecord[];
  lastNetworkBody?: { index: number; size: number; text: string };
};

/** The minimal data-passing a test harness needs: each data-producing action remembers its
 * one most recent result, and `emit` names which of those becomes the packet. A real
 * compiled runtime binds packets from declared variables (S6); this only ever has "the last
 * thing the script looked at", which is enough to prove extracted content reaches an emit
 * and nothing more ambitious than that. */
function packetFor(
  state: ScriptState,
  packetFrom: "lastExtract" | "lastNetworkList" | "lastNetworkBody" | undefined,
): Record<string, unknown> {
  switch (packetFrom) {
    case "lastExtract":
      return { records: state.lastExtract ?? [] };
    case "lastNetworkList":
      return { records: state.lastNetworkList ?? [] };
    case "lastNetworkBody":
      return { body: state.lastNetworkBody ?? null };
    default:
      return {};
  }
}

async function resolveBodyIndex(
  session: { network: { list: (opts?: { urlPattern?: string }) => Promise<{ records: NetworkListRecord[] }> } },
  step: { index?: number; urlPattern?: string },
): Promise<number> {
  if (step.index !== undefined) return step.index;
  if (step.urlPattern === undefined) {
    throw new AppError("scripted_action_invalid", "networkBody needs an index or a urlPattern", {
      details: { action: "networkBody" },
    });
  }
  const { records } = await session.network.list({ urlPattern: step.urlPattern });
  const match = records[0];
  if (!match) {
    throw new AppError("scripted_action_invalid", `no network record matches "${step.urlPattern}"`, {
      details: { action: "networkBody", urlPattern: step.urlPattern },
    });
  }
  return match.index;
}

async function runScript(
  session: Awaited<ReturnType<typeof openRunSession>>,
  script: ScriptAction[],
  handle: RunHandle,
): Promise<void> {
  const state: ScriptState = { currentPage: session.page };

  for (const step of script) {
    switch (step.action) {
      case "goto":
        await state.currentPage.goto(step.url);
        break;
      case "click":
        await state.currentPage.click(step.selector);
        break;
      case "waitFor":
        await state.currentPage.waitFor(
          step.selector,
          step.timeoutMs === undefined ? undefined : { timeout: step.timeoutMs },
        );
        break;
      case "extract":
        state.lastExtract = await state.currentPage.queryAll(step.selector, step.fields);
        break;
      case "openTab":
        state.currentPage = await session.openTab();
        break;
      case "networkList": {
        const { records } = await session.network.list(
          step.urlPattern === undefined ? undefined : { urlPattern: step.urlPattern },
        );
        state.lastNetworkList = records;
        break;
      }
      case "networkBody": {
        const index = await resolveBodyIndex(session, step);
        const bytes = await session.network.body(index);
        state.lastNetworkBody = { index, size: bytes.byteLength, text: bytes.toString("utf8") };
        break;
      }
      case "emit":
        await handle.emit(step.type, packetFor(state, step.packetFrom));
        break;
    }
  }
}

/**
 * A script action can fail with whatever the driver happens to throw once its underlying
 * connection is gone — Chromium's own response to a torn-down socket is not typed and not
 * stable across Playwright versions, so pattern-matching on it would be pattern-matching on
 * an implementation detail. Instead: ask the pool's own connection whether *it* now
 * considers the endpoint dead. If it does, that is the real cause of this failure, whatever
 * the in-flight call happened to throw on its way out — `wrap()`'s guard in `pool.ts` flips
 * synchronously the moment the driver's disconnect signal (or a failed ping) fires, so a
 * short poll is enough to outlast the race between "the call rejects" and "the pool notices".
 */
async function connectionIsDead(lease: EndpointLease, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dead = await lease.conn.version().then(
      () => false,
      (err: unknown) => err instanceof AppError && err.code === "browser.disconnected",
    );
    if (dead || Date.now() >= deadline) return dead;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * `RunResult.permanent` decisions (executor.ts's contract):
 *
 * - `browser.disconnected` is **not** permanent — a dropped connection is exactly the kind
 *   of transient fault the retry policy exists for; the pool reconnects with backoff and a
 *   later attempt may simply work.
 * - `resource_limit_exceeded` **is** permanent — the script and its limits are both fixed
 *   inputs to this task, so a retry replays the identical sequence against the identical
 *   cap and hits the identical wall. Unlike a disconnect, nothing about the *environment*
 *   this run depends on gets a chance to be different by attempt n+1.
 * - `endpoint_queue_full` is not permanent — backpressure that will not still be true the
 *   moment another run releases the endpoint.
 */
async function mapError(err: unknown, lease: EndpointLease | undefined): Promise<RunResult> {
  if (err instanceof AppError) {
    if (err.code === "browser.disconnected") return { ok: false, error: "browser.disconnected" };
    if (err.code === "resource_limit_exceeded") {
      return { ok: false, error: "resource_limit_exceeded", permanent: true };
    }
    if (err.code === "endpoint_queue_full") return { ok: false, error: "endpoint_queue_full" };
    return { ok: false, error: err.message };
  }
  if (lease && (await connectionIsDead(lease))) return { ok: false, error: "browser.disconnected" };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

const defaultStorageFlagsOf = (task: TaskRow): StorageFlags => parseLimits(task.limitsJson).storage;

/**
 * Composition-root style, like everything else in this codebase: every dependency arrives
 * explicit rather than reached for. Per run: acquire the endpoint, open a guarded and traced
 * session over `openRunSession` (never a second session type), execute the script in order,
 * and release/close in a `finally` regardless of outcome. Emits go through `handle.emit` —
 * the only path that runs packet validation, dedupe, the loop budget, and the outbox.
 */
export function createScriptedBrowserExecutor(deps: ScriptedExecutorDeps): TaskExecutor {
  const { pool, gate, blobs, db, defaultEndpointId, metrics } = deps;
  const storageFlagsOf = deps.storageFlagsOf ?? defaultStorageFlagsOf;

  return {
    async execute(handle: RunHandle): Promise<RunResult> {
      const { script, browser } = parseLimits(handle.task.limitsJson);

      let lease: EndpointLease | undefined;
      let session: Awaited<ReturnType<typeof openRunSession>> | undefined;
      try {
        lease = await pool.acquire(defaultEndpointId, handle.run.id);
        const trace = createTraceRecorder(db, blobs, handle.run.id, storageFlagsOf(handle.task));
        session = await openRunSession({
          conn: lease.conn,
          gate,
          taskCtx: { taskId: handle.task.id, runId: handle.run.id },
          trace,
          ...(metrics ? { metrics } : {}),
          ...(browser ? { limits: browser } : {}),
        });
        await runScript(session, script, handle);
        return { ok: true };
      } catch (err) {
        return mapError(err, lease);
      } finally {
        await session?.close().catch(() => undefined);
        await lease?.release().catch(() => undefined);
      }
    },
  };
}
