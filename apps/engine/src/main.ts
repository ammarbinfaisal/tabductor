import { validatePythonCandidate } from "@tabductor/agent";
import { eq } from "drizzle-orm";
import {
  createAgentExecutor,
  createCompiledExecutor,
  createCompileLoop,
  createCompileWorker,
  createDecisionExecutor,
  createResultExecutor,
  fundedLlm,
  remotePythonRunner,
  type CompileWorker,
} from "@tabductor/agent";
import { configuredBlobStore } from "@tabductor/browser";
import { createDispatcher, publish } from "@tabductor/bus";
import { loadConfig } from "@tabductor/core";
import { browserWorkers, createDb, type Db } from "@tabductor/db";
import {
  createEngine,
  createHostedBrowserPool,
  createSolverProvider,
  createCaptchaProviders,
  createCaptchaService,
  createModelResolver,
  modelScopeForTask,
  parseModelRates,
  parseSolverRates,
  executorKey,
  parsePaddleCreditPacks,
  processPendingPaddleWebhookEvents,
  recordEngineBoot,
  StubExecutor,
  StubResultExecutor,
  touchEngineHeartbeat,
  workflowIdForVersion,
  type ExecutorRegistry,
  type RunHandle,
  type TaskExecutor,
} from "@tabductor/engine";
import { RuntimeSafetyGate } from "@tabductor/core";
import { createSecretsBroker, configuredKeyWrapper, type SecretsBrokerRunDeps } from "@tabductor/secrets";
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
if (process.env.BROWSER_AGENT_BACKEND && process.env.BROWSER_AGENT_BACKEND !== "python")
  throw new Error("Browser execution is Python-only; remove BROWSER_AGENT_BACKEND=javascript");
if (process.env.BROWSER_MODE && process.env.BROWSER_MODE !== "fleet")
  throw new Error("Browser execution requires the Camoufox fleet; CDP endpoints are no longer supported");
const pythonRunner = remotePythonRunner(process.env.PYTHON_RUNNER_URL ?? "", process.env.PYTHON_RUNNER_TOKEN ?? "");
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
const endpointFor = (_db: Db) => async (handle: RunHandle) => handle.run.id;

/** One pool, one blob store, one gate for every browser-facing piece below — the compile
 * loop's dry run borrows an endpoint through the same pool the runs do, so the two never
 * hold one endpoint twice. */
const solverRates = parseSolverRates(config.SOLVER_RATES_JSON);
const solverKeys = { capsolver: config.CAPSOLVER_API_KEY, "2captcha": config.TWO_CAPTCHA_API_KEY, "anti-captcha": config.ANTI_CAPTCHA_API_KEY };
const unratedSolvers = Object.entries(solverKeys)
  .filter(([name, key]) => key && !solverRates.some(rate => rate.name === name))
  .map(([name]) => name);
if (unratedSolvers.length) log.warn("CAPTCHA provider keys are configured but these providers are disabled: add their rates to SOLVER_RATES_JSON", { providers: unratedSolvers });
const solvers = solverRates.map((rate) => createSolverProvider({ ...rate, apiKey: solverKeys[rate.name] ?? "" }));
const captchaProviders = createCaptchaProviders({ keys: solverKeys, rates: solverRates });
const browserPool = createHostedBrowserPool({ db: handle.db, solvers, challengeRecovery: "agent", tokenKey: process.env.BROWSER_WORKER_TOKEN_KEY ?? "", workerUrl: async (podName) => {
      const [worker] = await handle.db.select().from(browserWorkers).where(eq(browserWorkers.podName, podName));
      if (!worker?.endpointUrl) throw new Error("worker endpoint is unavailable");
      return worker.endpointUrl;
    } });
const blobs = configuredBlobStore(config);
// S7: one persisted evaluator shared by browser, decision-store, and secret paths.
const gate = new RuntimeSafetyGate({ navAllowlist: config.HARNESS_NAV_ALLOWLIST });

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
const modelResolver = createModelResolver({ db: handle.db, wrapper: configuredKeyWrapper(config),
  rates: parseModelRates(config.MODEL_RATES_JSON),
  platformKeys: { ...(config.OPENAI_API_KEY ? { openai: config.OPENAI_API_KEY } : {}), ...(config.ANTHROPIC_API_KEY ? { anthropic: config.ANTHROPIC_API_KEY } : {}) },
});
const compileLoop = createCompileLoop({
  db: handle.db,
  publish: async (input) => {
    await publish(handle.db, input);
  },
  metrics: telemetry.metrics,
  logger: log,
});

function compileWorkerEntry(db: Db): CompileWorker | undefined {
  return createCompileWorker({
    db,
    validatePython: (source,evidence,plan) => validatePythonCandidate(pythonRunner,source,evidence,plan),
    blobs,
    compileLlmFor: ({ task, job }) => fundedLlm(modelResolver, () => modelScopeForTask(db, task.id, "trace_compilation", job.runId)),
    publish: async (input) => {
      await publish(db, input);
    },
    metrics: telemetry.metrics,
    logger: log,
  });
}
const compileWorker = compileWorkerEntry(handle.db);


/** Browser tasks resolve the account model at call time. */
function agentExecutorEntry(db: Db): ReturnType<typeof createAgentExecutor> | undefined {

  const executor = createAgentExecutor({ pythonRunner,
    captchaFor: run => createCaptchaService({ db, handle: run, providers: captchaProviders }),
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
    llmFor: ({ trace, task, runId }) => fundedLlm(modelResolver, () => modelScopeForTask(db, task.id, "runtime", runId), trace),
  });
  return executor;
}

/** Browser secret sessions stay host-side and origin-bound. */
const liveSecretRuns = new Map<string, SecretsBrokerRunDeps>();
const secretsBroker = createSecretsBroker({
  db: handle.db,
  gate,
  keyWrapper: configuredKeyWrapper(config),
  resolveRun: (runId) => liveSecretRuns.get(runId),
  metrics: telemetry.metrics,
});

// -----------------------------------------------------------------------------------------
// S5g: `(decision, ai)` — the planner kind's executor. Same live-key gate as the other two
// `*Entry` functions above (nothing to run a live LLM call against without one); no CDP
// endpoint check, because a decision run acquires no browser session.
// -----------------------------------------------------------------------------------------
function decisionExecutorEntry(db: Db, pool: Pool): ReturnType<typeof createDecisionExecutor> | undefined {
  return createDecisionExecutor({
    db,
    pool,
    blobs,
    gate,
    metrics: telemetry.metrics,
    llmFor: ({ trace, task, runId }) => fundedLlm(modelResolver, () => modelScopeForTask(db, task.id, "runtime", runId), trace),
  });
}
// -----------------------------------------------------------------------------------------

/** Compiled recovery uses the same account model source. */
function compiledExecutorEntry(db: Db): TaskExecutor | undefined {

  return createCompiledExecutor({ pythonRunner,
    captchaFor: run => createCaptchaService({ db, handle: run, providers: captchaProviders }),
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
    onOutcome: (input) => compileLoop.afterCompiledRun(input),
    llmFor: ({ trace, task, runId }) => fundedLlm(modelResolver, () => modelScopeForTask(db, task.id, "recovery", runId), trace),
  });
}

const agentExecutor = agentExecutorEntry(handle.db);
const decisionExecutor = decisionExecutorEntry(handle.db, handle.pool);
const compiledExecutor = compiledExecutorEntry(handle.db);
const resultExecutor = createResultExecutor({ db: handle.db,
  llmFor: (run) => fundedLlm(modelResolver, () => modelScopeForTask(handle.db, run.task.id, "runtime", run.run.id)),
});
const executors: ExecutorRegistry = {
  [executorKey("result", "ai")]: resultExecutor,
  [executorKey("result", "stub")]: StubResultExecutor,
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
  prerequisites: { browserMode: "fleet",
    platformProviders: [...(config.OPENAI_API_KEY ? ["openai"] : []), ...(config.ANTHROPIC_API_KEY ? ["anthropic"] : [])],
    platformModels: parseModelRates(config.MODEL_RATES_JSON) },
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
