import { convertLegacyWallets, reconcileCaptchaJobs, processActionSummary, processWorkflowDeletion, syncProxyCosts } from "@tabductor/engine";
import { validatePythonCandidate } from "@tabductor/agent";
import { eq } from "drizzle-orm";
import {
  createAgentExecutor,
  createCompiledExecutor,
  createCompileLoop,
  createCompileWorker,
  createBrowserLearningWorker,
  finalizeWorkflow,
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
await convertLegacyWallets(handle.db);

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
const solverRates = parseSolverRates(config.SOLVER_USD_RATES_JSON);
const solverKeys = { capsolver: config.CAPSOLVER_API_KEY, "2captcha": config.TWO_CAPTCHA_API_KEY, "anti-captcha": config.ANTI_CAPTCHA_API_KEY };
const solvers = (Object.keys(solverKeys) as Array<keyof typeof solverKeys>).flatMap(name => {
  const apiKey=solverKeys[name];
  return apiKey?[createSolverProvider({...solverRates.find(rate=>rate.name===name),name,apiKey,rateVersion:solverRates.find(rate=>rate.name===name)?.rateVersion??"admin",creditUnits:solverRates.find(rate=>rate.name===name)?.creditUnits??0})]:[];
});
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
  rates: parseModelRates(config.MODEL_USD_RATES_JSON),
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
const learningWorker = createBrowserLearningWorker({ db: handle.db, blobs, logger: log,
  llmFor: ({ task, job }) => fundedLlm(modelResolver, () => modelScopeForTask(handle.db, task.id, "browser_learning", job.runId)),
});


/** Browser tasks resolve the account model at call time. */
function agentExecutorEntry(db: Db): ReturnType<typeof createAgentExecutor> | undefined {

  const executor = createAgentExecutor({ pythonRunner,
    captchaFor: run => createCaptchaService({ db, handle: run, providers: captchaProviders }),
    pool: browserPool,
    storePool: handle.pool,
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
    // Post-run learning improves prompts and decides compilation eligibility independently.
    // The hook only queues work, so the run settles without waiting for a model.
    onOutcome: async (input) => void (await compileLoop.afterAiRun(input)),
    llmFor: ({ trace, task, runId }) => fundedLlm(modelResolver, () => modelScopeForTask(db, task.id, "runtime", runId), trace),
  });
  return executor;
}

/** Browser secret sessions stay host-side and origin-bound. */
const liveSecretRuns = new Map<string, SecretsBrokerRunDeps>();
const secretsBroker = createSecretsBroker({
  db: handle.db,
  keyWrapper: configuredKeyWrapper(config),
  resolveRun: (runId) => liveSecretRuns.get(runId),
  metrics: telemetry.metrics,
});

// -----------------------------------------------------------------------------------------

// -----------------------------------------------------------------------------------------
/** Compiled recovery uses the same account model source. */
function compiledExecutorEntry(db: Db): TaskExecutor | undefined {

  return createCompiledExecutor({ pythonRunner,
    captchaFor: run => createCaptchaService({ db, handle: run, providers: captchaProviders }),
    pool: browserPool,
    storePool: handle.pool,
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
const compiledExecutor = compiledExecutorEntry(handle.db);
const executors: ExecutorRegistry = {
  [executorKey("browser", "stub")]: StubExecutor,
  ...(agentExecutor ? { [executorKey("browser", "ai")]: agentExecutor } : {}),
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
    platformModels: parseModelRates(config.MODEL_USD_RATES_JSON) },
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
let finalizationWork: Promise<void> | undefined;
const finalizationTimer = setInterval(() => {
  if (finalizationWork) return;
  finalizationWork = finalizeWorkflow({ db: handle.db,
    llmFor: (versionId, runId) => fundedLlm(modelResolver, () => modelScopeForTask(handle.db, versionId, "runtime", runId)) })
    .catch(error => log.error("workflow finalization failed", { error: String(error) }))
    .finally(() => { finalizationWork = undefined; });
}, 1000);
finalizationTimer.unref();

learningWorker.start();
// U3a: tell the control plane what this process can run, and keep saying so. The editor's
// mode selector and `/status` read this row; a stale heartbeat reads as "engine down".
await recordEngineBoot(handle.db, Object.keys(executors));
const heartbeat = setInterval(() => {
  void touchEngineHeartbeat(handle.db).catch((err) => log.warn("engine heartbeat failed", { error: String(err) }));
}, 5_000);
heartbeat.unref();
const paddlePacks = config.PADDLE_USD_PACKS_JSON
  ? parsePaddleCreditPacks(config.PADDLE_USD_PACKS_JSON)
  : new Map();
const paymentReconciler = config.PADDLE_API_KEY ? setInterval(() => {
  void processPendingPaddleWebhookEvents(handle.db, paddlePacks)
    .catch((err) => log.warn("payment webhook reconciliation failed", { error: String(err) }));
}, 2_000) : undefined;
paymentReconciler?.unref();
const summaryWork = new Set<Promise<void>>();
const summaryTimer = setInterval(() => {
  for (let n = summaryWork.size; n < 4; n++) {
    const work = processActionSummary(handle.db).catch(error => log.warn("action summary failed", { error: String(error) })).finally(() => summaryWork.delete(work));
    summaryWork.add(work);
  }
}, 1000);
summaryTimer.unref();
let maintenanceWork:Promise<void>|undefined;
const maintenance=setInterval(()=>{
  if(maintenanceWork)return;
  maintenanceWork=Promise.allSettled([convertLegacyWallets(handle.db),reconcileCaptchaJobs(handle.db,captchaProviders),processWorkflowDeletion(handle.db,handle.pool,blobs),syncProxyCosts(handle.db)])
    .then(results=>{for(const result of results)if(result.status==="rejected")log.warn("billing maintenance failed",{error:String(result.reason)});})
    .finally(()=>{maintenanceWork=undefined;});
},2000);
maintenance.unref();
log.info("engine started", {
  database: config.DATABASE_URL.replace(/\/\/[^@]*@/, "//"),
  telemetry: telemetry.enabled ? "exporting" : "disabled",
  aiExecutor: agentExecutor ? "registered" : "not registered",
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
    clearInterval(maintenance);
    await maintenanceWork;
    if (paymentReconciler) clearInterval(paymentReconciler);
    clearInterval(finalizationTimer);
    clearInterval(summaryTimer);
    await Promise.allSettled([...(finalizationWork ? [finalizationWork] : []), ...summaryWork]);
    await compileWorker?.stop();
    await learningWorker.stop();
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
