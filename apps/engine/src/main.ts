import {
  createAgentExecutor,
  createAssetExecutor,
  createCompiledExecutor,
  createDecisionExecutor,
  createLlm,
  providerFromEnv,
} from "@tabductor/agent";
import { createEndpointPool, createMinioBlobStore, playwrightDriver } from "@tabductor/browser";
import { createDispatcher } from "@tabductor/bus";
import { loadConfig } from "@tabductor/core";
import { cdpEndpoints, createDb, type Db } from "@tabductor/db";
import {
  AssetExecutor,
  createEngine,
  executorKey,
  StubExecutor,
  type ExecutorRegistry,
  type TaskExecutor,
} from "@tabductor/engine";
import { createPyrunClient, createPythonExecutor } from "@tabductor/engine/python";
import { AllowAllGate } from "@tabductor/policy";
import { createSecretsBroker, fileKeyWrapper } from "@tabductor/secrets";
import { initTelemetry } from "@tabductor/telemetry/init";
import { asc } from "drizzle-orm";
import type { Pool } from "pg";

/**
 * The engine process: the composition root that wires the packages together and runs them
 * (impl-phases, repository layout). It owns *execution* — the dispatcher draining the
 * outbox, the run loop, the scheduler, the timeout watchdog and crash recovery. The web
 * process owns definitions and read models. The two share nothing but Postgres.
 *
 * Everything it starts is already system-tested; the only thing that lives here is
 * lifecycle, and the only thing lifecycle has to get right is shutdown.
 */

const config = loadConfig();
// One of the two places `initTelemetry` may be called (§17.2 rule 1). Everything below
// receives what it needs by injection; no package here imports the OTel SDK. With no OTLP
// endpoint configured this is inert — no exporters, no sockets, no timers.
const telemetry = await initTelemetry({ service: "tabductor-engine" });
const log = telemetry.logger;
const handle = createDb(config.DATABASE_URL);

/**
 * The first browser node executor this process can run (S4b): `AgentExecutor` under mode
 * `ai`. Two things gate whether it gets registered at all, both checked once at boot rather
 * than per run:
 *
 * 1. **A live LLM key.** `providerFromEnv` is the same selection rule the schema compiler
 *    uses (`schema-generator-ai.ts`) — Anthropic wins if both are set. With neither set,
 *    registering the executor anyway would hand the engine a mode it can dispatch runs to but
 *    can never actually call a model for; every one of those runs would fail deep inside the
 *    loop's first `llm.complete`, indistinguishably from a real outage. A run failing
 *    `no_executor` up front (the engine's own existing behaviour for an unregistered mode) is
 *    the honest failure — it says "not configured," not "broke."
 * 2. **A CDP endpoint to drive.** There is no per-task or per-user endpoint assignment model
 *    yet (S3b's `ScriptedBrowserExecutor` doc note says the same thing) — a real deployment
 *    manages `cdp_endpoints` rows through the control plane, not through engine config, so
 *    the *composition root* has no endpoint to declare up front the way a test rig does.
 *    Reading the oldest row at boot is a stopgap for "the endpoint this single-user install
 *    talks to" until a later subphase gives tasks their own; with zero rows the executor is
 *    withheld for the identical reason as a missing key — nothing to run it against.
 */
async function agentExecutorEntry(db: Db): Promise<ReturnType<typeof createAgentExecutor> | undefined> {
  const live = providerFromEnv({ ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY, OPENAI_API_KEY: config.OPENAI_API_KEY });
  if (!live) {
    log.info("no ANTHROPIC_API_KEY/OPENAI_API_KEY configured — (browser, ai) has no executor", {});
    return undefined;
  }
  const [endpointRow] = await db.select({ id: cdpEndpoints.id }).from(cdpEndpoints).orderBy(asc(cdpEndpoints.createdAt)).limit(1);
  if (!endpointRow) {
    log.info("no cdp_endpoints row configured — (browser, ai) has no executor", {});
    return undefined;
  }

  const pool = createEndpointPool({ db, driver: playwrightDriver, metrics: telemetry.metrics, logger: log });
  const blobs = createMinioBlobStore({
    endpoint: config.BLOB_ENDPOINT,
    accessKey: config.BLOB_ACCESS_KEY,
    secretKey: config.BLOB_SECRET_KEY,
    bucket: config.BLOB_BUCKET,
  });
  // `AllowAllGate` reads `HARNESS_NAV_ALLOWLIST` from config itself when no allowlist is
  // passed (impl-phases §0.1) — the real evaluator (Phase 7) replaces this construction, not
  // this call site.
  const gate = new AllowAllGate();

  const executor = createAgentExecutor({
    pool,
    gate,
    blobs,
    db,
    defaultEndpointId: endpointRow.id,
    metrics: telemetry.metrics,
    // One live provider serves every task — `task` is here for the test rig's benefit, not
    // this composition root's; see `AgentExecutorDeps.llmFor`.
    llmFor: ({ trace }) =>
      createLlm("live", {
        provider: live.provider,
        apiKey: live.apiKey,
        trace,
        metrics: telemetry.metrics,
        costLabels: { kind: "browser", mode: "ai" },
      }),
  });
  return executor;
}

/**
 * The MCP client's credential path (S5c, §13): `injectIntoMcpArg`/`redeemMcpHandle` only —
 * never the full `SecretsBroker` (`fill` is browser-only and unreachable from an asset run
 * regardless). `resolveRun` always answers "no live session," honestly: nothing in this
 * process registers a browser session with the broker yet (`secrets.fill` is not wired into
 * the browser registry as of S5c either — a later subphase's business), and
 * `injectIntoMcpArg`/`redeemMcpHandle` never call `resolveRun` at all (`broker.ts`'s own
 * comment: "an asset-node run has no page to bind an origin to"), so this is not a stub
 * standing in for missing wiring — it is the correct, permanent answer for this call site.
 */
const secretsBroker = createSecretsBroker({
  db: handle.db,
  keyWrapper: fileKeyWrapper(config.SECRETS_KEK_FILE_PATH),
  resolveRun: () => undefined,
  metrics: telemetry.metrics,
});

/**
 * The first asset-node executor this process can run for real (S5c): `createAssetExecutor`
 * under mode `ai` — the mode techical_plan's diagram calls "always ai mode" for this kind.
 * Gated on a live LLM key only, the honest half of `agentExecutorEntry`'s two-part gate
 * above: an asset run acquires no browser session and no CDP endpoint at all (§4), so there
 * is nothing here to check a `cdp_endpoints` row for.
 */
function assetExecutorEntry(db: Db, pool: Pool): ReturnType<typeof createAssetExecutor> | undefined {
  const live = providerFromEnv({ ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY, OPENAI_API_KEY: config.OPENAI_API_KEY });
  if (!live) {
    log.info("no ANTHROPIC_API_KEY/OPENAI_API_KEY configured — (asset, ai) has no executor", {});
    return undefined;
  }
  const blobs = createMinioBlobStore({
    endpoint: config.BLOB_ENDPOINT,
    accessKey: config.BLOB_ACCESS_KEY,
    secretKey: config.BLOB_SECRET_KEY,
    bucket: config.BLOB_BUCKET,
  });
  const gate = new AllowAllGate();

  return createAssetExecutor({
    gate,
    blobs,
    db,
    pool,
    metrics: telemetry.metrics,
    secrets: secretsBroker,
    llmFor: ({ trace }) =>
      createLlm("live", {
        provider: live.provider,
        apiKey: live.apiKey,
        trace,
        metrics: telemetry.metrics,
        costLabels: { kind: "asset", mode: "ai" },
      }),
  });
}

// -----------------------------------------------------------------------------------------
// S5g: `(decision, ai)` — the planner kind's executor. Same live-key gate as the other two
// `*Entry` functions above (nothing to run a live LLM call against without one); no CDP
// endpoint or MCP-server check, because a decision run acquires neither (§2.1: `store.query`
// + `emit` only).
// -----------------------------------------------------------------------------------------
function decisionExecutorEntry(db: Db, pool: Pool): ReturnType<typeof createDecisionExecutor> | undefined {
  const live = providerFromEnv({ ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY, OPENAI_API_KEY: config.OPENAI_API_KEY });
  if (!live) {
    log.info("no ANTHROPIC_API_KEY/OPENAI_API_KEY configured — (decision, ai) has no executor", {});
    return undefined;
  }
  const blobs = createMinioBlobStore({
    endpoint: config.BLOB_ENDPOINT,
    accessKey: config.BLOB_ACCESS_KEY,
    secretKey: config.BLOB_SECRET_KEY,
    bucket: config.BLOB_BUCKET,
  });

  return createDecisionExecutor({
    db,
    pool,
    blobs,
    metrics: telemetry.metrics,
    llmFor: ({ trace }) =>
      createLlm("live", {
        provider: live.provider,
        apiKey: live.apiKey,
        trace,
        metrics: telemetry.metrics,
        costLabels: { kind: "decision", mode: "ai" },
      }),
  });
}
// -----------------------------------------------------------------------------------------

/**
 * S5h: `(asset, python)`. Withheld without a `PYRUNNER_URL` for the same reason the AI
 * executors are withheld without a key — registering something that can only fail deep inside
 * a run is worse than declining it at boot and saying so.
 */
function pythonExecutorEntry(db: typeof handle.db): TaskExecutor | undefined {
  if (!config.PYRUNNER_URL) {
    log.info("no PYRUNNER_URL configured — (asset, python) has no executor", {});
    return undefined;
  }
  return createPythonExecutor({
    db,
    blobs: createMinioBlobStore({
      endpoint: config.BLOB_ENDPOINT,
      accessKey: config.BLOB_ACCESS_KEY,
      secretKey: config.BLOB_SECRET_KEY,
      bucket: config.BLOB_BUCKET,
    }),
    pyrun: createPyrunClient({ url: config.PYRUNNER_URL }),
    metrics: telemetry.metrics,
  });
}

/**
 * S6c: `(browser, compiled)`. Gated on the same two things `(browser, ai)` is — an endpoint to
 * drive and a model key — because a compiled run needs the first always and the second the
 * moment its guards fail. A compiled task whose deopt had nowhere to go would fail runs that
 * the agent could have finished.
 */
async function compiledExecutorEntry(db: Db): Promise<TaskExecutor | undefined> {
  const live = providerFromEnv({ ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY, OPENAI_API_KEY: config.OPENAI_API_KEY });
  if (!live) {
    log.info("no ANTHROPIC_API_KEY/OPENAI_API_KEY configured — (browser, compiled) has no executor", {});
    return undefined;
  }
  const [endpointRow] = await db
    .select({ id: cdpEndpoints.id })
    .from(cdpEndpoints)
    .orderBy(asc(cdpEndpoints.createdAt))
    .limit(1);
  if (!endpointRow) {
    log.info("no cdp_endpoints row configured — (browser, compiled) has no executor", {});
    return undefined;
  }

  const pool = createEndpointPool({ db, driver: playwrightDriver, metrics: telemetry.metrics, logger: log });
  const blobs = createMinioBlobStore({
    endpoint: config.BLOB_ENDPOINT,
    accessKey: config.BLOB_ACCESS_KEY,
    secretKey: config.BLOB_SECRET_KEY,
    bucket: config.BLOB_BUCKET,
  });
  return createCompiledExecutor({
    pool,
    gate: new AllowAllGate(),
    blobs,
    db,
    defaultEndpointId: endpointRow.id,
    metrics: telemetry.metrics,
    llmFor: ({ trace }) =>
      createLlm("live", {
        provider: live.provider,
        apiKey: live.apiKey,
        trace,
        metrics: telemetry.metrics,
        // The deopt path is the only thing here that ever calls a model, so cost recorded
        // under mode `compiled` is exactly the cost of guards that stopped holding.
        costLabels: { kind: "browser", mode: "compiled" },
      }),
  });
}

const agentExecutor = await agentExecutorEntry(handle.db);
const assetExecutor = assetExecutorEntry(handle.db, handle.pool);
const decisionExecutor = decisionExecutorEntry(handle.db, handle.pool);
const pythonExecutor = pythonExecutorEntry(handle.db);
const compiledExecutor = await compiledExecutorEntry(handle.db);
const executors: ExecutorRegistry = {
  [executorKey("browser", "stub")]: StubExecutor,
  // The S5a scripted-behavior skeleton, now at mode `stub` — S5c's real `(asset, ai)`
  // executor (below) takes over the mode an asset task actually runs in production;
  // `AssetExecutor` stays registered here for the graph-testing/stub-mode harness the same
  // way `StubExecutor` does for `(browser, stub)`.
  [executorKey("asset", "stub")]: AssetExecutor,
  ...(agentExecutor ? { [executorKey("browser", "ai")]: agentExecutor } : {}),
  ...(assetExecutor ? { [executorKey("asset", "ai")]: assetExecutor } : {}),
  // S5g: no stub-mode decision registration — a decision task has no scripted-behavior
  // skeleton to fall back to (nothing analogous to `AssetExecutor`'s S5a-era stand-in was
  // ever needed for it, since `store.query` + `emit` had no MCP/LaTeX gap to bridge before
  // being buildable for real).
  ...(decisionExecutor ? { [executorKey("decision", "ai")]: decisionExecutor } : {}),
  // S5h: `mode=python` is confined to `kind=asset` by `checkGraph` and the check constraint,
  // so this is the only pair it can ever resolve to.
  ...(pythonExecutor ? { [executorKey("asset", "python")]: pythonExecutor } : {}),
  ...(compiledExecutor ? { [executorKey("browser", "compiled")]: compiledExecutor } : {}),
};

const dispatcher = createDispatcher(handle, {
  logger: log,
  tracer: telemetry.tracer,
  metrics: telemetry.metrics,
});
const engine = createEngine({
  db: handle.db,
  dispatcher,
  executors,
  logger: log,
  tracer: telemetry.tracer,
  metrics: telemetry.metrics,
});

/**
 * Engine before dispatcher, deliberately. `engine.start()` runs crash recovery and then
 * subscribes; starting the dispatcher first would let it deliver events to a bus with no
 * subscriber on it, and those deliveries would be marked dispatched with nobody having
 * acted on them.
 */
await engine.start();
await dispatcher.start();
log.info("engine started", {
  database: config.DATABASE_URL.replace(/\/\/[^@]*@/, "//"),
  telemetry: telemetry.enabled ? "exporting" : "disabled",
  aiExecutor: agentExecutor ? "registered" : "not registered",
  assetAiExecutor: assetExecutor ? "registered" : "not registered",
  decisionAiExecutor: decisionExecutor ? "registered" : "not registered",
  pythonExecutor: pythonExecutor ? "registered" : "not registered",
  compiledExecutor: compiledExecutor ? "registered" : "not registered",
});

/**
 * Stop taking work, let in-flight runs finish within the engine's grace period, then close
 * the pool. Anything still running when the grace expires is left `running` and belongs to
 * the crash-recovery watchdog on the next boot — which is a tested path, not a hope.
 *
 * Guarded against a second signal: docker sends SIGTERM and then SIGKILL, and an impatient
 * operator sends two SIGINTs.
 */
let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  try {
    await dispatcher.stop();
    await engine.stop();
    await handle.close();
    // Last, so spans and metrics from the shutdown itself are flushed with everything else.
    await telemetry.shutdown();
  } catch (err) {
    log.error("shutdown failed", { error: String(err) });
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// A rejection nobody handled is a bug; log it with the process still up rather than dying
// mid-run on Node's default behaviour.
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: String(reason) }));
