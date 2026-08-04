# Agentic Browsing Platform — Incremental Implementation Plan (Backend-First)

**Version:** 0.1
**Companion to:** `agentic-browsing-platform-design.md` (the design doc). Section references (§) below point there.
**Ordering constraints (decided):** backend only until the tooling + event architecture is stable; UI afterwards; policy/permissions engine at the end. Testing is backend system testing throughout — no UI tests.

---

## 0. The one architectural precondition for deferring policy

Deferring the policy engine is workable **only if every phase routes actions through a policy interface from day one**, with a permissive implementation:

```ts
// packages/policy/src/gate.ts
export interface PolicyGate {
  checkAction(taskCtx: TaskCtx, action: BrowserAction): Promise<Verdict>;
  checkNavigation(taskCtx: TaskCtx, url: URL, cause: NavCause): Promise<Verdict>;
  checkNetworkRead(taskCtx: TaskCtx, req: ReqRef, parts: ReadParts): Promise<Verdict>;
  checkMcpCall(taskCtx: TaskCtx, tool: string): Promise<Verdict>;
  redact(taskCtx: TaskCtx, payload: NetworkPayload): NetworkPayload; // no-op until Phase 7
}

export type Verdict = { allow: true } | { allow: false; rule: string };

export class AllowAllGate implements PolicyGate { /* returns {allow:true}, redact = identity */ }
```

Everything downstream (browser runtime, agent tools, static runtime `ctx`, MCP client) takes a `PolicyGate` via constructor injection and never acts without a verdict. Phase 7 then swaps `AllowAllGate` for the real evaluator — **no call-site changes, no rewrite**. If instead you let early phases call the CDP driver directly, Phase 7 becomes a hunt through every action site, and you will miss one. This interface is ~50 lines; build it in Phase 1.

Two small carve-outs I'd keep even in the "no policy yet" phases, stated directly because skipping them is how dev accidents happen against a real browser:

1. A single env-var **domain allowlist** (`HARNESS_NAV_ALLOWLIST=x.com,instagram.com,localhost`) enforced in the browser runtime's navigation guard. It's one regex check inside `AllowAllGate.checkNavigation`, not a policy system, and it prevents an early prompt-injected or confused agent from wandering your logged-in browser to arbitrary domains during development.
2. **Resource limits** (tabs / wall-clock / max visits, §8) live in the runtime from Phase 3. These are correctness/cost controls, not permissions — they don't belong to the deferred policy work.

---

## Repository & runtime layout

TypeScript monorepo (pnpm workspaces). One deployable process in early phases (`engine`), splitting later only if needed.

```
/packages
  /core        — shared types, ids, errors, config loader, zod schemas
  /db          — migrations (node-pg-migrate), query layer (kysely), outbox helpers
  /bus         — event bus: publish (outbox), dispatcher, dedupe, lineage
  /engine      — workflow engine: graph eval, run state machine, scheduler
  /policy      — PolicyGate interface + AllowAllGate (real evaluator in Phase 7)
  /browser     — CDP driver interface, playwright-cdp impl, pool, queues,
                 network observer, trace recorder, action API
  /agent       — browser agent: perception builder, tool registry, agent loop,
                 LLM adapter (live + replay)
  /compiler    — trace consistency checker, compiler agent, script registry
  /static-rt   — isolated-vm host, ctx implementation
  /mcp         — MCP client + per-task tool routing
/apps
  /engine      — composition root: wires packages, runs dispatcher+scheduler+executors
  /testkit     — fixture web server, mock CDP target launcher, LLM transcript tools
/tests
  /system      — cross-package system tests (the ones that matter)
```

**Test infrastructure (built in Phase 0, used forever):**

- `docker-compose.test.yml`: Postgres 16; headless Chromium launched with `--remote-debugging-port` on a throwaway `--user-data-dir` (this *is* your BYO-CDP simulator — tests connect to it exactly the way production connects to a user's endpoint); the fixture site server.
- **Fixture sites** (`apps/testkit/sites/`): small deterministic HTML apps served locally — `fake-tweets` (a timeline page with data attributes, plus a `POST /admin/add-tweet` endpoint so tests can inject "new tweets" mid-run), `fake-gram` (a form that records submissions), `mutator` (same page, but layout switchable via query param — used to force deopts in Phase 6), `slowpoke` (configurable latency/timeouts). Fixture sites are the backbone of system testing: real Chromium, real CDP, zero external network.
- **LLM replay adapter**: the `agent` package's LLM client has `mode: "live" | "record" | "replay"`. `record` runs against the real API and writes the full transcript (prompts, tool calls, results) to a fixture file; `replay` serves the recorded tool-call sequence deterministically. System tests run in `replay` (fast, free, deterministic); a small separate `live-eval` suite runs `live` nightly/manually to catch model drift. Never let CI depend on live LLM calls.
- Test DB lifecycle: each system test gets a schema-per-test (template database clone) — parallel-safe, no shared-state flakes.

---

## Phase 1 — State store + Event bus

**Goal:** durable events with at-least-once delivery, dedupe, and lineage. No tasks yet — publishers and consumers are test doubles.

**Build:**

- Migrations for: `events`, `run_dedupe`, `outbox`, plus the skeleton tables the engine will need (`workflows`, `workflow_versions`, `tasks`, `edges`, `event_defs`, `runs`) — schema per §14, even if some columns go unused for a phase or two. Migrating early beats renumbering later.
- **Outbox publisher:** domain writes and their events commit in one transaction (`INSERT INTO outbox`); a dispatcher loop polls the outbox (`FOR UPDATE SKIP LOCKED`, batch of N), publishes to in-process subscribers, marks rows dispatched. `LISTEN/NOTIFY` as a wake-up latch to keep poll latency low without tight loops.
- **Dispatcher contract:** delivery to a subscriber that throws → row stays undelivered, retried with backoff column (`attempts`, `next_attempt_at`); after max attempts → `dead_letter` status + a `system.event_dead_lettered` event.
- **Dedupe helper:** `claim(taskId, eventId)` — unique insert into `run_dedupe`; returns claimed/duplicate.
- **Lineage:** every published event carries `causation_id`; helper computes chain depth by walking `events` (recursive CTE, capped) — used later for loop budgets, tested now.
- `PolicyGate` interface + `AllowAllGate` (see §0 above).

**System tests:**

- Transactionality: kill the process between domain write and outbox dispatch (test hook) → after restart, event is delivered exactly once to the subscriber's dedupe-guarded handler.
- At-least-once + dedupe: force redelivery (reset dispatched flag) → subscriber handler called twice, `claim` admits once.
- Dead-letter path after N failing deliveries; `system.event_dead_lettered` observable.
- Lineage depth computation on a synthetic 50-deep chain; cap respected.
- Throughput smoke: 10k events through the outbox under 60s on dev hardware (guards against accidental O(n²) polling).

**Exit:** bus semantics are boringly reliable; every later phase publishes through it.

## Phase 2 — Workflow engine + scheduler (stub executors)

**Goal:** the full trigger→dispatch→run→emit loop working *without a browser*. Tasks are executed by a **StubExecutor** that reads a scripted behavior from the task definition (`emit these events with these packets after this delay / fail / hang`). This is deliberate: the engine's correctness must be testable independently of browsers and LLMs, and the StubExecutor remains permanently useful for testing graphs.

**Build:**

- **Task executor abstraction:** `interface TaskExecutor { execute(run: RunHandle): Promise<RunResult> }` — implementations: `StubExecutor` (now), `AgentExecutor` (Phase 4), `CompiledExecutor` (Phase 6). Registered per task `mode`.
- **Run state machine** (§4): `queued → running → succeeded|failed|timed_out|cancelled` (approval state arrives in Phase 7). Transitions are DB writes + system events (`run.completed`, `run.failed`, `run.timed_out`). Run-level timeout enforced by the engine (watchdog scanning `running` runs past deadline — not `setTimeout`, so it survives restarts).
- **Graph evaluation:** on event delivery, resolve subscribers via `edges (from_task, event_type → to_task)` against the *latest* workflow version; runs pin the version they started under (`runs.workflow_version_id`).
- **Packet validation:** `event_defs.packet_schema_json` (JSON Schema via zod-from-schema) validated at emit; invalid → emit fails, run fails with a clear error.
- **Loop budget:** on dispatch, compute lineage depth; over per-workflow `max_hops` → drop trigger, emit `system.loop_budget_exceeded`.
- **Retry policy** per task (`max_retries`, backoff); retried runs reuse the trigger `event_id` (dedupe is on side-effect keys, not on run creation — a retry is a *new run row*, same trigger).
- **Scheduler:** cron (`croner` lib) with tz; each due fire inserts a synthetic event through the outbox (schedules are just an event source, §7). Missed-fire policy (`skip`/`fire_once_catchup`) computed from `last_fired_at` at startup; overlap policy (`skip`/`queue(1)`) checked against live runs for the task.
- **Crash recovery:** heartbeat column on `runs`; on boot, `running` runs with stale heartbeats → `failed(engine_restart)` → retry policy applies.

**System tests (all with StubExecutor + real Postgres + real bus):**

- Linear chain A→B→C: packets flow, variables from A's packet visible to B's run record.
- Fan-out: one event, three subscriber tasks, three runs, independent failures don't affect siblings.
- Cycle A→B→A with `max_hops=6` → exactly 6 hops then `loop_budget_exceeded`.
- Packet schema violation → emit rejected, run failed, no downstream runs.
- Timeout: hanging stub → `timed_out` at deadline ±1 poll interval; watchdog works across a process restart (start hang, restart engine, verify).
- Retry with backoff: stub fails twice then succeeds → 3 run rows, one trigger event, downstream fired once.
- Scheduler: fake clock injection; cron fires; overlap `skip` verified with a long-running stub; missed-fire `skip` vs `fire_once_catchup` after simulated downtime.
- Graph versioning: edit graph mid-run → in-flight run completes under old version; its emitted event routes per new version.

**Exit:** the events architecture is done and system-tested. (Per your ordering, this is the "basic tooling + events ready" gate — UI work *could* start in parallel from here, consuming the same DB/APIs, but nothing in later phases depends on it.)

## Phase 3 — Browser runtime + CDP layer (no AI yet)

**Goal:** connect to user-style CDP endpoints, execute a fixed action script (not agent-driven), observe network, record traces, enforce resource limits.

**Build:**

- **Driver interface** insulating from Playwright/Puppeteer (§20): `connect(wsUrl)`, `createPage()`, `goto`, `click`, `type`, `waitFor`, `queryAll`, `screenshot`, `close`, plus network event subscription. First implementation: Playwright `connectOverCDP`.
- **Endpoint pool:** `cdp_endpoints` table; health check loop (`Browser.getVersion` ping); reconnect with backoff; disconnect mid-run → run fails `browser.disconnected` (system event). **Per-endpoint run queue** (serialize by default, §8) implemented as a DB claim (`endpoint_leases` row with heartbeat) so it holds across engine restarts.
- **Navigation guard:** every navigation (initial, redirect, window.open — hook `frameNavigated` and route interception) passes through `PolicyGate.checkNavigation` (currently env-allowlist, §0). Denied → abort navigation, record trace entry.
- **Network observer:** CDP `Network.*` → normalized records `{index, method, url, resourceType, status, timings}`; bodies fetched lazily (`Network.getResponseBody`) only when something asks (nobody asks yet). All records → trace.
- **Trace recorder:** append-only `trace_entries` writer (buffered, flushed on transition), blob offload (screenshots, bodies) to object storage with `blob_ref`. Storage opt-out flags read per task at write time — flags exist now; the settings UI for them comes later.
- **Resource limits:** tab counter, visit counter, wall clock — enforced in the runtime; breach → abort with `resource_limit_exceeded`.
- **ScriptedBrowserExecutor** (test-only executor): runs a JSON list of driver actions. This is *not* the compiler's static runtime — it's a thin test harness to exercise the browser layer before an agent exists.

**System tests (real headless Chromium from docker-compose, fixture sites):**

- Scripted flow against `fake-tweets`: navigate → extract via `queryAll` → assert trace contains navigation, actions, network records for the page's XHRs.
- Redirect off-allowlist (`fixture → https://example.com`) → navigation aborted, trace shows denial.
- Resource limits: script opening tabs beyond limit / visiting beyond max → correct abort reason.
- Endpoint serialization: two runs queued to one endpoint → sequential (assert via trace timestamps); two endpoints → parallel.
- Kill Chromium mid-run → `browser.disconnected` failure, retry policy re-runs, endpoint health flips unhealthy→healthy after container restart.
- Trace blob offload: screenshot lands in object store, `blob_ref` resolves.

**Exit:** the harness can drive a real user-style CDP endpoint deterministically with full tracing.

## Phase 4 — Browser agent (AI mode)

**Goal:** `AgentExecutor` — LLM-driven browsing over the Phase 3 runtime, with the network read tool.

**Build:**

- **Perception builder:** page snapshot = accessibility tree + trimmed DOM (interactive elements with stable anchors: test-ids, roles, text) + optional screenshot; token-budgeted (§8). Every element handed to the model carries an anchor id the runtime can resolve back to a locator — the trace records the *resolved locator*, which the compiler needs later.
- **Tool registry** (exposed to the LLM): `page.goto/click/type/scroll/waitFor/extract`, `network.list` (batched summaries, §9 step 2), `network.read(index, parts)` — **implemented now, permissive via AllowAllGate**; the header-deny default is a Phase 7 policy change, not a tool change — the tool shape, pagination, and trace recording are identical, `emit(type, packet)`, `done(result)` / `fail(reason)`.
- **Agent loop:** system prompt (task prompt + declared emit schemas + tool docs) → tool-call loop → step budget + run timeout from the engine. Every LLM call (prompt hash, tokens, tool calls) → trace.
- **LLM adapter** with `live | record | replay` (see test infrastructure). Recorded transcripts are checked into fixtures for the canonical flows.
- **Structured emit:** `emit` validates against the node's packet schema *before* publishing (agent gets the validation error back as a tool result and may retry within budget — this materially improves reliability vs. failing the run on first malformed packet).

**System tests:**

- **Replay tests (CI):** canonical `fake-tweets` flow — recorded transcript drives: goto, extract, `emit tweet.detected × 3` with dedupe keys; downstream stub task receives packets. Deterministic, no API key in CI.
- Network tool: replay transcript where the agent calls `network.list` then `network.read(body)` on a fixture XHR → correct body in transcript context, trace records the read.
- Emit validation retry: transcript with one malformed emit then a corrected one → run succeeds, one downstream trigger.
- Step-budget exhaustion → run fails `step_budget_exceeded`.
- **Live-eval suite (manual/nightly, not CI):** same fixtures, `live` mode, asserting *outcomes* only (correct events emitted), never exact action sequences. This is your model-drift alarm.
- **First end-to-end milestone:** `fake-tweets` (cron, agent) → `tweet.detected` → agent task 2 → posts to `fake-gram`, with `emitIfNew` dedupe preventing double-posts across scheduler re-fires. Run in replay in CI, live in the eval suite.

**Exit:** the product works in `ai` mode against fixtures and (manually) against real sites.

## Phase 5 — MCP integration + secrets fill

**Build:**

- **MCP client** (`@modelcontextprotocol/sdk`): per-user server configs; per-task tool list merged into the agent's tool registry with a namespace (`mcp.imagegen.create`); calls via `PolicyGate.checkMcpCall` (permissive); args/results → trace; per-run call budget + timeout; results wrapped in delimiters as untrusted data (§13).
- **Secrets vault, minimal mechanism** (the *storage/fill mechanism* is infrastructure; the *grant policy* around it is Phase 7): `secrets` table, sealed-box encryption, and the `secrets.fill(name, anchor)` tool — harness types the value; the value never enters LLM context or traces (trace records the name only). Getting this in *before* anyone wires a real Instagram login means credentials never pass through prompts even during the permissive phases.

**System tests:** fake MCP server in testkit (echo/image-stub tools) — agent replay transcript calls it, result in context, trace recorded; call-budget breach → run fails; secrets: fill into `fake-gram` login form → submitted value correct server-side, value absent from every trace entry and every recorded transcript (assert by grep of the run's full trace + transcript — this test is non-negotiable).

## Phase 6 — Compiler + static runtime (deopt loop)

**Goal:** `CompiledExecutor` and the self-healing JIT loop (§11–§12).

**Build order within the phase (each step testable alone):**

1. **Static runtime host:** `isolated-vm` isolate; inject only `ctx` (page/guard/network/emit/emitIfNew/deopt/state per §12); every `ctx` call crosses to host → `PolicyGate` → driver; wall-clock + memory caps; no ambient globals (verify: `fetch`, `require`, `process` undefined in-isolate).
2. **Script registry:** `compiled_scripts` versions with `status: candidate|active|invalidated`, provenance (`from_runs`), lint gate (AST check: no `eval`/`Function`/imports/`with`; only `ctx.*` member calls).
3. **Trace consistency checker:** given K traces for a task, do resolved locators + flow match? Output: the *stable anchor set* + observed waits — the compiler agent's input.
4. **Compiler agent:** LLM (live/record/replay like Phase 4) that takes checker output + traces → script per the §11 template (guards, static path, `ctx.deopt(recoveryPrompt, evidence)`). Output must pass lint + a **dry-run in the sandbox against a fixture replay** before becoming `candidate`.
5. **Executor + deopt handoff:** `CompiledExecutor` runs the active script; `deopt()` → same run continues under `AgentExecutor` with recovery prompt + guard evidence + current page (mid-run handoff, §11); success → trace flagged `deopt_recovery` → recompile queue.
6. **Promotion/demotion:** promote to `compiled` after K=2 consistent clean AI runs; demote to `ai` + `compile.invalidated` after 3 deopts in 10 runs (counters on `tasks`).

**System tests:**

- Sandbox: hostile script fixtures (infinite loop → wall-clock kill; memory bomb → cap; attempts at `this.constructor.constructor('return process')` → undefined; direct network attempt → no primitive exists). Write these as table-driven tests; extend the table every time you think of a new escape.
- Golden compile: recorded compiler transcript over the canonical `fake-tweets` traces → snapshot-test the emitted script (normalized); lint gate rejects a corpus of bad scripts (eval, import, non-ctx calls).
- **Deopt loop end-to-end (the flagship test):** run task twice in AI mode (replay) → auto-compiles → run in compiled mode against `fake-tweets` → succeeds with *zero LLM calls* (assert on trace) → flip fixture to `mutator?layout=v2` → guards fail → deopt → agent (replay transcript for the recovery) finishes the run → recompile produces v2 → next run: compiled v2, zero LLM calls, on the new layout.
- Demotion: force 3 deopts in 10 via mutator toggling → task mode flips to `ai`, `compile.invalidated` emitted.
- `emitIfNew` + `ctx.state`: compiled polling run twice against unchanged fixture → second run emits nothing.

**Exit:** cost curve realized — steady-state runs make no LLM calls; site changes self-heal. Instrument LLM-cost-per-run (ai vs compiled) now; it's the product's core claim.

## Phase 7 — Policy & permissions engine (the deferred piece)

**Build:** the real `PolicyGate` implementation replacing `AllowAllGate` at the composition root — grants tables (`task_grants`, `account_baseline_rules` if accepted, §10), evaluator (baseline denies → task grants → default-deny for network header/secret reads, default-allow for basic actions during migration, tightening per rollout flag), redaction filter (§9 step 4: Authorization/Cookie/token-pattern masking even under header grants, `secrets:read` as the separate louder switch), approvals (`awaiting_approval` run state + park/expiry + `approval.requested|granted|denied` events — the state machine slot was reserved in Phase 2), navigation guard now driven by per-task allowlists instead of the env var, and MCP allowlists.

**System tests:**

- **Decision-table tests** on the evaluator alone: exhaustive grant × action matrix as data-driven cases (this is where most policy bugs die cheaply).
- Enforcement-point integration: (a) un-granted tool absent from the agent's tool list (assert against the replay adapter's captured tool schema); (b) compiled script calling an un-granted `ctx` method → verdict denial → deopt-or-fail per config → `policy.denied` traced; (c) redirect to off-grant domain aborted mid-run.
- Redaction: fixture endpoint returning `Set-Cookie` + bearer tokens; with `headers:read` granted but not `secrets:read` → masked in agent context (assert transcript) yet raw in the (opted-in) trace; with neither → `network.read(headers)` denied.
- Approval flow: purchase-class action on `fake-gram` with `requires_approval` → run parks, event emitted, test approves via API → run resumes and completes; expiry path → run fails `approval_expired`.
- **Regression sweep:** the *entire* Phase 2–6 system-test suite re-runs under a permissive-grants profile — proving the gate swap changed nothing when grants allow everything. This is the payoff of §0; if this sweep fails, the interface leaked somewhere.

## Phase 8 — UI (out of backend scope, listed for sequence)

React Flow editor over `workflows/edges/event_defs`, run inspector over `trace_entries` (the inspector first — you'll want it while hardening), grants editor, approvals inbox. The backend API for all of it already exists as the same service endpoints the system tests exercise; keep it that way (system tests as living API contract).

---

## Cross-phase testing doctrine (summary)

| Layer | What | Runs where |
|---|---|---|
| Unit | pure logic: cron math, lineage depth, lint gate, evaluator decision tables, redaction | every commit |
| Integration | one package + real Postgres (schema-per-test) | every commit |
| System | engine + bus + real Chromium + fixture sites + LLM **replay** | every commit (the core suite) |
| Live eval | same fixtures, LLM **live**, outcome assertions only | nightly / pre-release |
| Chaos | kill engine / kill Chromium / drop DB conn mid-run, assert recovery semantics | nightly |

Rules: no CI test touches the public internet or a live LLM; every bug fix lands with a system test reproducing it; traces are the assertion surface (most system-test asserts read `trace_entries` + `events`, not internal state) — which keeps tests black-box against refactors and doubles as proof your observability actually observes.
