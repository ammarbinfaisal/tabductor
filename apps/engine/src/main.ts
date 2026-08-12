import { createAgentExecutor, createLlm, providerFromEnv } from "@tabductor/agent";
import { createEndpointPool, createMinioBlobStore, playwrightDriver } from "@tabductor/browser";
import { createDispatcher } from "@tabductor/bus";
import { loadConfig } from "@tabductor/core";
import { cdpEndpoints, createDb, type Db } from "@tabductor/db";
import { createEngine, StubExecutor, type ExecutorRegistry } from "@tabductor/engine";
import { AllowAllGate } from "@tabductor/policy";
import { initTelemetry } from "@tabductor/telemetry/init";
import { asc } from "drizzle-orm";

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
async function agentExecutorEntry(db: Db): Promise<[mode: string, executor: ReturnType<typeof createAgentExecutor>] | undefined> {
  const live = providerFromEnv({ ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY, OPENAI_API_KEY: config.OPENAI_API_KEY });
  if (!live) {
    log.info("no ANTHROPIC_API_KEY/OPENAI_API_KEY configured — mode 'ai' has no executor", {});
    return undefined;
  }
  const [endpointRow] = await db.select({ id: cdpEndpoints.id }).from(cdpEndpoints).orderBy(asc(cdpEndpoints.createdAt)).limit(1);
  if (!endpointRow) {
    log.info("no cdp_endpoints row configured — mode 'ai' has no executor", {});
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
  return ["ai", executor];
}

const agentEntry = await agentExecutorEntry(handle.db);
const executors: ExecutorRegistry = {
  stub: StubExecutor,
  ...(agentEntry ? { [agentEntry[0]]: agentEntry[1] } : {}),
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
  aiExecutor: agentEntry ? "registered" : "not registered",
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
