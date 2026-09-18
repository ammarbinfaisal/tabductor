import { eq } from "drizzle-orm";
import {
  createAgentExecutor,
  createCompiledExecutor,
  createCompileLoop,
  createCompileWorker,
  createDecisionExecutor,
  createLlm,
  fundedLlm,
  providerFromEnv,
  type CompileWorker,
} from "@tabductor/agent";
import { createEndpointPool, createMinioBlobStore, playwrightDriver } from "@tabductor/browser";
import { createDispatcher, publish } from "@tabductor/bus";
import { loadConfig } from "@tabductor/core";
import { browserWorkers, createDb, type Db } from "@tabductor/db";
import {
  createEngine,
  createHostedBrowserPool,
  createModelResolver,
  modelScopeForTask,
  parseModelRates,
  executorKey,
  pickWorkflowEndpoint,
  parsePaddleCreditPacks,
  processPendingPaddleWebhookEvents,
  recordEngineBoot,
  StubExecutor,
  touchEngineHeartbeat,
  workflowIdForVersion,
  type ExecutorRegistry,
  type RunHandle,
  type TaskExecutor,
} from "@tabductor/engine";
import { RuntimeSafetyGate } from "@tabductor/core";
import { createSecretsBroker, fileKeyWrapper, type SecretsBrokerRunDeps } from "@tabductor/secrets";
import { initTelemetry } from "@tabductor/telemetry/init";
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
 * U3a: which browser a run drives. Resolved per run from the run's workflow — the rotation
 * over its "Browser endpoints" setting (`pickWorkflowEndpoint`) — so a workflow with no
 * endpoints fails `no_endpoint_configured` at run time instead of the whole `(browser, ai)`
 * mode being withheld at boot because the *table* was empty.
 */
const endpointFor = (db: Db) => async (handle: RunHandle) =>
  config.TABDUCTOR_DEPLOYMENT_MODE === "hosted" || process.env.BROWSER_MODE === "fleet" ? handle.run.id : pickWorkflowEndpoint(db, await workflowIdForVersion(db, handle.task.workflowVersionId));

/** One pool, one blob store, one gate for every browser-facing piece below — the compile
 * loop's dry run borrows an endpoint through the same pool the runs do, so the two never
 * hold one endpoint twice. */
const browserPool = config.TABDUCTOR_DEPLOYMENT_MODE === "hosted" || process.env.BROWSER_MODE === "fleet"
  ? createHostedBrowserPool({ db: handle.db, tokenKey: process.env.BROWSER_WORKER_TOKEN_KEY ?? "", workerUrl: async (podName) => {
      const [worker] = await handle.db.select().from(browserWorkers).where(eq(browserWorkers.podName, podName));
      if (!worker?.endpointUrl) throw new Error("worker endpoint is unavailable");
      return worker.endpointUrl;
    } })
  : createEndpointPool({ db: handle.db, driver: playwrightDriver, metrics: telemetry.metrics, logger: log });
const blobs = createMinioBlobStore({
  endpoint: config.BLOB_ENDPOINT,
  accessKey: config.BLOB_ACCESS_KEY,
  secretKey: config.BLOB_SECRET_KEY,
  bucket: config.BLOB_BUCKET,
});
// S7: one persisted evaluator shared by browser, decision-store, and secret paths.
const gate = new RuntimeSafetyGate({ navAllowlist: config.HARNESS_NAV_ALLOWLIST });
const liveProvider = providerFromEnv({ ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY, OPENAI_API_KEY: config.OPENAI_API_KEY });

/**
 * The compile loop's two halves (`compile-loop.ts`).
 *
 * The **hooks** are cheap and always wired: after a `(browser, ai)` run they advance the
 * promotion counter and queue a compile; after a `(browser, compiled)` run they feed the deopt
 * window and demote a task that keeps deopting. No model is needed for any of that, so unlike
 * the executors this half does not depend on a provider key.
 *
 * The **worker** is what actually compiles, and it is a separate process-level thing with its
 * own poll, timeout and retry budget. It needs the model, so it exists exactly when a provider
 * key does — with none configured, jobs simply queue up and wait for an engine that has one.
 */
const modelResolver = createModelResolver({ db: handle.db, wrapper: fileKeyWrapper(config.SECRETS_KEK_FILE_PATH),
  rates: parseModelRates(config.MODEL_RATES_JSON),
  platformKeys: { ...(config.OPENAI_API_KEY ? { openai: config.OPENAI_API_KEY } : {}), ...(config.ANTHROPIC_API_KEY ? { anthropic: config.ANTHROPIC_API_KEY } : {}) },
});
const funded = config.TABDUCTOR_DEPLOYMENT_MODE === "hosted";
const compileLoop = createCompileLoop({
  db: handle.db,
  publish: async (input) => {
    await publish(handle.db, input);
  },
  metrics: telemetry.metrics,
  logger: log,
});

function compileWorkerEntry(db: Db): CompileWorker | undefined {
  if (!liveProvider && !funded) {
    log.info("no ANTHROPIC_API_KEY/OPENAI_API_KEY configured — compiles will queue but not run", {});
    return undefined;
  }
  const live = liveProvider;
  return createCompileWorker({
    db,
    compileLlmFor: ({ task, job }) => funded ? fundedLlm(modelResolver, () => modelScopeForTask(db, task.id, "trace_compilation", job.runId)) :
      createLlm("live", {
        provider: live!.provider,
        apiKey: live!.apiKey,
        metrics: telemetry.metrics,
        costLabels: { kind: "browser", mode: "compile" },
      }),
    publish: async (input) => {
      await publish(db, input);
    },
    metrics: telemetry.metrics,
    logger: log,
  });
}
const compileWorker = compileWorkerEntry(handle.db);


/**
 * The first browser node executor this process can run (S4b): `AgentExecutor` under mode
 * `ai`. Gated on a live LLM key, checked once at boot rather than per run: `providerFromEnv`
 * is the same selection rule the schema compiler uses (`schema-generator-ai.ts`) — Anthropic
 * wins if both are set. With neither set, registering the executor anyway would hand the
 * engine a mode it can dispatch runs to but can never actually call a model for; every one
 * of those runs would fail deep inside the loop's first `llm.complete`, indistinguishably
 * from a real outage. A run failing `no_executor` up front is the honest failure — it says
 * "not configured," not "broke." The CDP endpoint is *not* a boot gate any more (U3a): it
 * is a per-workflow setting, resolved by `endpointFor` per run.
 */
function agentExecutorEntry(db: Db): ReturnType<typeof createAgentExecutor> | undefined {
  const live = providerFromEnv({ ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY, OPENAI_API_KEY: config.OPENAI_API_KEY });
  if (!live && !funded) {
    log.info("no ANTHROPIC_API_KEY/OPENAI_API_KEY configured — (browser, ai) has no executor", {});
    return undefined;
  }

  const executor = createAgentExecutor({
    pool: browserPool,
    gate,
    blobs,
    db,
    endpointFor: endpointFor(db),
    metrics: telemetry.metrics,
    secrets: secretsBroker,
    registerSecretRun: (runId, run) => {
      liveSecretRuns.set(runId, run);
      return () => liveSecretRuns.delete(runId);
    },
    // The first clean run makes the task eligible (K=1); the hook only queues the compile,
    // so the run settles without waiting for a model.
    onOutcome: async (input) => void (await compileLoop.afterAiRun(input)),
    // One live provider serves every task — `task` is here for the test rig's benefit, not
    // this composition root's; see `AgentExecutorDeps.llmFor`.
    llmFor: ({ trace, task, runId }) => funded ? fundedLlm(modelResolver, () => modelScopeForTask(db, task.id, "runtime", runId), trace) :
      createLlm("live", {
        provider: live!.provider,
        apiKey: live!.apiKey,
        trace,
        metrics: telemetry.metrics,
        costLabels: { kind: "browser", mode: "ai" },
      }),
  });
  return executor;
}

/** Browser secret sessions stay host-side and origin-bound. */
const liveSecretRuns = new Map<string, SecretsBrokerRunDeps>();
const secretsBroker = createSecretsBroker({
  db: handle.db,
  gate,
  keyWrapper: fileKeyWrapper(config.SECRETS_KEK_FILE_PATH),
  resolveRun: (runId) => liveSecretRuns.get(runId),
  metrics: telemetry.metrics,
});

// -----------------------------------------------------------------------------------------
// S5g: `(decision, ai)` — the planner kind's executor. Same live-key gate as the other two
// `*Entry` functions above (nothing to run a live LLM call against without one); no CDP
// endpoint check, because a decision run acquires no browser session.
// -----------------------------------------------------------------------------------------
function decisionExecutorEntry(db: Db, pool: Pool): ReturnType<typeof createDecisionExecutor> | undefined {
  const live = providerFromEnv({ ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY, OPENAI_API_KEY: config.OPENAI_API_KEY });
  if (!live && !funded) {
    log.info("no ANTHROPIC_API_KEY/OPENAI_API_KEY configured — (decision, ai) has no executor", {});
    return undefined;
  }
  return createDecisionExecutor({
    db,
    pool,
    blobs,
    gate,
    metrics: telemetry.metrics,
    llmFor: ({ trace, task, runId }) => funded ? fundedLlm(modelResolver, () => modelScopeForTask(db, task.id, "runtime", runId), trace) :
      createLlm("live", {
        provider: live!.provider,
        apiKey: live!.apiKey,
        trace,
        metrics: telemetry.metrics,
        costLabels: { kind: "decision", mode: "ai" },
      }),
  });
}
// -----------------------------------------------------------------------------------------

/**
 * S6c: `(browser, compiled)`. Gated on the model key like `(browser, ai)` — a compiled run
 * needs a model the moment its guards fail, and a compiled task whose deopt had nowhere to
 * go would fail runs that the agent could have finished. The endpoint is per run (U3a).
 */
function compiledExecutorEntry(db: Db): TaskExecutor | undefined {
  const live = providerFromEnv({ ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY, OPENAI_API_KEY: config.OPENAI_API_KEY });
  if (!live && !funded) {
    log.info("no ANTHROPIC_API_KEY/OPENAI_API_KEY configured — (browser, compiled) has no executor", {});
    return undefined;
  }

  return createCompiledExecutor({
    pool: browserPool,
    gate,
    blobs,
    db,
    endpointFor: endpointFor(db),
    metrics: telemetry.metrics,
    onOutcome: (input) => compileLoop.afterCompiledRun(input),
    llmFor: ({ trace, task, runId }) => funded ? fundedLlm(modelResolver, () => modelScopeForTask(db, task.id, "recovery", runId), trace) :
      createLlm("live", {
        provider: live!.provider,
        apiKey: live!.apiKey,
        trace,
        metrics: telemetry.metrics,
        // The deopt path is the only thing here that ever calls a model, so cost recorded
        // under mode `compiled` is exactly the cost of guards that stopped holding.
        costLabels: { kind: "browser", mode: "compiled" },
      }),
  });
}

const agentExecutor = agentExecutorEntry(handle.db);
const decisionExecutor = decisionExecutorEntry(handle.db, handle.pool);
const compiledExecutor = compiledExecutorEntry(handle.db);
const executors: ExecutorRegistry = {
  [executorKey("browser", "stub")]: StubExecutor,
  ...(agentExecutor ? { [executorKey("browser", "ai")]: agentExecutor } : {}),
  ...(decisionExecutor ? { [executorKey("decision", "ai")]: decisionExecutor } : {}),
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
compileWorker?.start();
// U3a: tell the control plane what this process can run, and keep saying so. The editor's
// mode selector and `/status` read this row; a stale heartbeat reads as "engine down".
await recordEngineBoot(handle.db, Object.keys(executors));
const heartbeat = setInterval(() => {
  void touchEngineHeartbeat(handle.db).catch((err) => log.warn("engine heartbeat failed", { error: String(err) }));
}, 5_000);
heartbeat.unref();
const paddlePacks = config.PADDLE_CREDIT_PACKS_JSON
  ? parsePaddleCreditPacks(config.PADDLE_CREDIT_PACKS_JSON)
  : undefined;
const paymentReconciler = paddlePacks ? setInterval(() => {
  void processPendingPaddleWebhookEvents(handle.db, paddlePacks)
    .catch((err) => log.warn("payment webhook reconciliation failed", { error: String(err) }));
}, 2_000) : undefined;
paymentReconciler?.unref();
log.info("engine started", {
  database: config.DATABASE_URL.replace(/\/\/[^@]*@/, "//"),
  telemetry: telemetry.enabled ? "exporting" : "disabled",
  aiExecutor: agentExecutor ? "registered" : "not registered",
  decisionAiExecutor: decisionExecutor ? "registered" : "not registered",
  compiledExecutor: compiledExecutor ? "registered" : "not registered",
  compileWorker: compileWorker ? "running" : "not running (no model configured)",
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
    clearInterval(heartbeat);
    if (paymentReconciler) clearInterval(paymentReconciler);
    await compileWorker?.stop();
    await dispatcher.stop();
    await engine.stop();
    await browserPool.close();
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
