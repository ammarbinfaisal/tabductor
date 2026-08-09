# Agentic Browsing Platform — Incremental Implementation Plan (Backend-First)

**Version:** 0.2
**Companion to:** `techical_plan.md` (the design doc). Section references (§) below point there. Resolved §18 decisions are folded in below and in the design doc itself.
**Ordering constraints (decided):** backend only until the tooling + event architecture is stable; UI afterwards; policy/permissions engine at the end. Testing is backend system testing throughout — no UI tests.

**Changes in 0.2:** two node kinds (§4) — `browser` and `asset`. MCP moves off the browser node onto the asset node, joined by the asset store and LaTeX document generation. What was Phase 5 (MCP + secrets) is now **Phase 5 (asset node)**; the compiler and policy phases shift by one and gain kind-awareness.

---

## Status — as of 2026-08-08

| Subphase | Scope | State |
|---|---|---|
| S0 | Monorepo scaffold, core, testkit (fixture sites, CDP launcher, test DBs) | **done** — `15914a0` |
| S1 | Drizzle data layer, outbox bus, dedupe, lineage, PolicyGate/AllowAllGate | **done** — `7e2b7fd` |
| S2a | Engine core: run state machine, graph dispatch, packet validation, loop budget, StubExecutor | **done** — `f2e2f23` |
| S2b | Scheduler (cron/tz, missed/overlap, queue depth), retries, crash-recovery watchdog | **built, uncommitted** — `scheduler.ts`, `retry.ts`, migrations `0003`/`0004`, 3 system tests green |
| S2c | Next.js + tRPC control-plane API | not started |
| S3a–S7 | browser, agent, asset, compiler, policy | not started |

Phase 1 and Phase 2 of this document are therefore complete except for the control-plane API
(S2c). The `tasks.kind` column (§4) does not exist yet and is added in **S5a** below — it is a
nullable-defaulted `text` column alongside the existing `mode`, so no backfill and no rewrite of
S2a's executor registry, which already keys on a discriminant.

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
  /mcp         — MCP client + per-task tool routing (asset node only)
  /assets      — asset store (paths, versions, blobs) + LaTeX renderer client
  /secrets     — envelope encryption, KMS wrapping, fill/inject broker
/apps
  /engine      — composition root: wires packages, runs dispatcher+scheduler+executors
  /web         — Next.js + tRPC control plane (S2c)
  /renderer    — out-of-process LaTeX render worker (containerised, network-less)
  /testkit     — fixture web server, mock CDP target launcher, LLM transcript tools
/tests
  /system      — cross-package system tests (the ones that matter)
```

**Test infrastructure (built in Phase 0, used forever):**

- `docker-compose.test.yml`: Postgres 16; headless Chromium launched with `--remote-debugging-port` on a throwaway `--user-data-dir` (this *is* your BYO-CDP simulator — tests connect to it exactly the way production connects to a user's endpoint); the fixture site server.
- **Fixture sites** (`apps/testkit/sites/`): small deterministic HTML apps served locally — `fake-tweets` (a timeline page with data attributes, plus a `POST /admin/add-tweet` endpoint so tests can inject "new tweets" mid-run), `fake-gram` (a form that records submissions), `mutator` (same page, but layout switchable via query param — used to force deopts in Phase 6), `slowpoke` (configurable latency/timeouts). Fixture sites are the backbone of system testing: real Chromium, real CDP, zero external network.
- **LLM replay adapter**: the `agent` package's LLM client has `mode: "live" | "record" | "replay"`. `record` runs against the real API and writes the full transcript (prompts, tool calls, results) to a fixture file; `replay` serves the recorded tool-call sequence deterministically. System tests run in `replay` (fast, free, deterministic); a small separate `live-eval` suite runs `live` nightly/manually to catch model drift. Never let CI depend on live LLM calls.
- Test DB lifecycle: each system test gets a schema-per-test (template database clone) — parallel-safe, no shared-state flakes.
- **Fake MCP server** (Phase 5): stdio MCP server in testkit exposing `echo` and an image-stub tool that returns a fixed PNG — deterministic, no external calls, exercises the client, the budget, and the untrusted-result wrapping.
- **LaTeX fixtures** (Phase 5): a happy-path `.tex`, a malformed `.tex` (missing package, stray `&`) for the correct-and-retry path, and a **hostile corpus** (`\write18`, `\input{/etc/passwd}`, macro loop, memory bomb) — table-driven, extended whenever someone thinks of a new escape, exactly as with the `isolated-vm` corpus in Phase 6. PDF comparisons normalize timestamps and document IDs before asserting.

---

## Phase 1 — State store + Event bus ✅ **DONE** (S1)

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

## Phase 2 — Workflow engine + scheduler (stub executors) ✅ **DONE** (S2a committed, S2b uncommitted; S2c API outstanding)

**Goal:** the full trigger→dispatch→run→emit loop working *without a browser*. Tasks are executed by a **StubExecutor** that reads a scripted behavior from the task definition (`emit these events with these packets after this delay / fail / hang`). This is deliberate: the engine's correctness must be testable independently of browsers and LLMs, and the StubExecutor remains permanently useful for testing graphs.

**Build:**

- **Task executor abstraction:** `interface TaskExecutor { execute(run: RunHandle): Promise<RunResult> }` — implementations: `StubExecutor` (now), `AgentExecutor` (Phase 4), `CompiledExecutor` (Phase 6). Registered per task `mode`.
- **Run state machine** (§4): `queued → running → succeeded|failed|timed_out|cancelled` (approval state arrives in Phase 7). Transitions are DB writes + system events (`run.completed`, `run.failed`, `run.timed_out`). Run-level timeout enforced by the engine (watchdog scanning `running` runs past deadline — not `setTimeout`, so it survives restarts).
- **Graph evaluation:** on event delivery, resolve subscribers via `edges (from_task, event_type → to_task)` against the *latest* workflow version; runs pin the version they started under (`runs.workflow_version_id`).
- **Packet validation:** `event_defs.packet_schema_json` (JSON Schema via zod-from-schema) validated at emit; invalid → emit fails, run fails with a clear error.
- **Loop budget:** on dispatch, compute lineage depth; over per-workflow `max_hops` → drop trigger, emit `system.loop_budget_exceeded`.
- **Retry policy** per task (`max_retries`, backoff); retried runs reuse the trigger `event_id` (dedupe is on side-effect keys, not on run creation — a retry is a *new run row*, same trigger).
- **Task concurrency (event-triggered runs):** per-task `parallelism` setting — `parallel` (independent events for the same task run concurrently; the case: a fast emitter feeding a slow consumer) or `queue` (serialize runs per task). Note this is an *engine-level* dispatch policy; per-endpoint browser serialization (§8, Phase 3) still applies underneath on the browser layer.
- **Scheduler:** cron (`croner` lib) with tz; each due fire inserts a synthetic event through the outbox (schedules are just an event source, §7). Missed-fire policy (`skip`/`fire_once_catchup`) computed from `last_fired_at` at startup; overlap policy (`skip`/`queue`) checked against live runs for the task, with a **user-configurable max queue depth** (default 1) per schedule.
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

**Goal:** `AgentExecutor` — LLM-driven browsing over the Phase 3 runtime, with the network read tool. This is the **browser node** (§4); it never gains `mcp.*` or `assets.write` in any later phase.

**Build:**

- **Perception builder:** page snapshot = accessibility tree + trimmed DOM (interactive elements with stable anchors: test-ids, roles, text) + optional screenshot; token-budgeted (§8). Every element handed to the model carries an anchor id the runtime can resolve back to a locator — the trace records the *resolved locator*, which the compiler needs later.
- **Tool registry** (exposed to the LLM): `page.goto/click/type/scroll/waitFor/extract`, `network.list` (batched summaries, §9 step 2), `network.read(index, parts)` — **implemented now, permissive via AllowAllGate**; the header-deny default is a Phase 7 policy change, not a tool change — the tool shape, pagination, and trace recording are identical, `emit(type, packet)`, `done(result)` / `fail(reason)`.
- **Agent loop:** system prompt (task prompt + declared emit schemas + the trigger event's packet fields, injected per the emitting node's declared schema + tool docs) → tool-call loop → step budget + run timeout from the engine. Every LLM call (prompt hash, tokens, tool calls) → trace.
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

## Phase 5 — Asset nodes: MCP + asset store + LaTeX + secrets

**Goal:** the second node kind (§4). An `AssetExecutor` that consumes events, calls MCP tools, writes files, renders LaTeX deliverables, and emits asset refs — with no browser anywhere in the phase.

This is the phase that makes the harness the selling point, and it is deliberately built *after* the browser agent so that the event-packet contract between the two kinds is exercised end-to-end the moment it exists.

### S5a — `kind` discriminant + AssetExecutor skeleton

- Migration: `tasks.kind text not null default 'browser'`. Existing rows are browser tasks; no backfill. `mode` is untouched and stays orthogonal (§4).
- Executor registry keys on `(kind, mode)` instead of `mode`. S2a's registry already indirects through a discriminant, so this is a lookup-key change, not a rewrite.
- **Engine constraints, enforced at write time not dispatch time:** a schedule may not bind to a `kind=asset` task; a `kind=asset` task may not be set to `mode=compiled`. Both rejected by the control-plane API (S2c) with a typed error, and re-asserted by a DB check constraint so a direct insert cannot create an unroutable graph.
- `AssetExecutor` initially runs the same scripted-behavior path as `StubExecutor` (emit these events, fail, hang) so the kind plumbing is testable before any MCP or LaTeX exists.

**Tests:** schedule→asset binding rejected; `kind=asset` + `mode=compiled` rejected; asset task triggered by an event from a browser task runs under `AssetExecutor`; browser tasks are unaffected (the entire Phase 2 suite re-runs green).

### S5b — Secrets broker

Built before MCP and before assets, so no credential ever passes through a prompt even during the permissive phases.

- `secrets`, `secret_grants`, `secret_access_log` per §14. Envelope encryption: per-secret DEK (libsodium XChaCha20-Poly1305), DEK wrapped by a KMS KEK (§16 Threat 4). Dev/test use a local KEK file behind the same `KeyWrapper` interface KMS implements — the interface exists from day one so the swap is config, not code.
- Broker interface is **exactly** `fill(runId, name, anchor)` and `injectIntoMcpArg(runId, name)`. **No `get(name): string` is defined anywhere.** A lint rule and a code-review checklist item both guard this; the absence is the control (§16).
- Tier 1 (server-decryptable) only in this subphase. Tier 2 (user-wrapped, attended-only) is Phase 7 — it needs the approval machinery.
- Origin binding (`allowed_origins`) is stored and **enforced now**, not deferred to policy: the broker checks the page's live origin at fill time. It is a property of the secret, not a task grant.

**Tests (the value-leak test is non-negotiable):** fill into `fake-gram`'s login form → server-side submitted value correct; then grep the run's *entire* trace, every recorded LLM transcript, and every log line for the plaintext → zero hits. Origin binding: same secret, wrong origin → fill refused, `policy.denied` traced. Target validation: hidden field / cross-origin iframe → refused. Rate limit: N fills in one run → run fails.

### S5c — MCP client

- `@modelcontextprotocol/sdk`; per-user server configs (`mcp_servers`); server credentials resolved via `secrets.injectIntoMcpArg` — never in `config_json`.
- Per-task tool list merged into **the asset node's** registry with a namespace (`mcp.imagegen.create`). The browser node's registry is untouched and must not gain `mcp.*` — asserted by a test, since this is the §4 security boundary and a future refactor could silently erase it.
- Calls via `PolicyGate.checkMcpCall` (permissive until Phase 7); args/results → trace; per-run call budget + timeout; results wrapped in delimiters as untrusted data (§13).

**Tests:** fake MCP server in testkit (echo + image-stub tools) — asset-node replay transcript calls it, result in context, trace recorded; call-budget breach → run fails; **registry isolation test**: build a browser task's tool schema and assert no tool name matches `mcp.*`; MCP server credential absent from trace and transcript.

### S5d — Asset store

- `assets`, `asset_versions`, `asset_write_grants` per §14. Blobs via the existing `BlobStore` interface (local FS now, S3 later).
- Path handling: normalize, reject `..`/absolute/symlink, resolve within the user namespace root (§16 Threat 8). Writes checked against the task's `asset_write_grants` glob; reads open across the user's workflows (§13.5 decision).
- Tools: `assets.write/append/read/list`. Every write creates an `asset_versions` row; overwrites never destroy the prior blob.
- **Asset refs in packets:** a `{asset_id, path, mime, sha256}` shape registered as a reusable fragment for the LLM-generated packet schemas (§18.2), so the model does not invent its own shape per node.

**Tests:** traversal corpus (`../../etc/passwd`, absolute paths, symlink, unicode-normalized dodges) all rejected — table-driven, extend on every new idea; write outside grant glob → denied; overwrite → new version, old blob still resolvable; asset ref round-trips through an event packet and validates against the fragment schema.

### S5e — LaTeX renderer

- `apps/renderer`: out-of-process worker, containerised, **no network namespace**, read-only FS except a per-render scratch dir, `tectonic` with shell escape disabled unconditionally, `openin_any=p`/`openout_any=p`, wall-clock + memory caps (§13.5, §16 Threat 7).
- `assets.render(srcPath, format, opts)` → `pdf`. Deck output is beamer→PDF and is labelled a **PDF deck** in the API and UI, not a `.pptx` (§18.11). **`docx` is not implemented** (§18.12) — the tool rejects it with an explicit "deferred, see §13.5" error rather than silently degrading.
- Images referenced by the `.tex` are resolved from the asset store into the scratch dir **by the host before compilation**; the `.tex` never names a host path.
- Non-zero exit → the TeX log is returned to the agent as a tool error so it can correct and retry within budget. This matters: LaTeX from an LLM fails on missing packages and stray characters routinely, and a one-shot failure would make the feature unusable.
- Tectonic's package cache is pre-warmed into the image so the render container needs no network at runtime.

**Tests (hostile corpus, table-driven like the sandbox tests in Phase 6):** `\write18{curl ...}` → blocked; `\input{/etc/passwd}` → blocked; infinite macro loop → wall-clock kill; memory bomb → cap; a `.tex` attempting to write outside scratch → blocked. Happy path: fixture `.tex` → byte-stable PDF (normalize timestamps/IDs before comparing); malformed `.tex` → TeX log surfaced as a tool error, agent's corrected retry succeeds.

### S5f — End-to-end milestone (the phase's exit criterion)

`fake-tweets` (cron, browser node) → `tweet.detected` → **asset node** calls the image-stub MCP tool, writes a `.tex`, renders a PDF, emits `report.ready {asset_ref}` → **browser node** uploads it to `fake-gram` via `page.upload(anchor, assetRef)`.

Asserts: the PDF exists and is valid; the browser node received bytes matching the asset's `sha256`; the asset outlives the run that created it; the whole flow is replay-deterministic in CI.

**Exit:** both node kinds work, exchange data only through validated packets, and the tool registries are provably disjoint.

## Phase 6 — Compiler + static runtime (deopt loop)

**Goal:** `CompiledExecutor` and the self-healing JIT loop (§11–§12).

**Scope: `kind=browser` only** (§18.10). The compiler's task selector filters on `kind='browser'`; asset tasks are exempt from promotion/demotion counters entirely. Add one test asserting an asset task with K clean runs is *not* compiled — a silent widening of the selector would put MCP calls behind guards that cannot assert on them.

**Build order within the phase (each step testable alone):**

1. **Static runtime host:** `isolated-vm` isolate; inject only `ctx` (page/guard/network/emit/emitIfNew/deopt/state per §12, plus read-only `ctx.page.upload(anchor, assetRef)`); **no `ctx.mcp`, no asset writes** — the compiled path must mirror the browser node's registry exactly, or it becomes the policy bypass §2 principle 3 forbids; every `ctx` call crosses to host → `PolicyGate` → driver; wall-clock + memory caps; no ambient globals (verify: `fetch`, `require`, `process` undefined in-isolate).
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

**Build:** the real `PolicyGate` implementation replacing `AllowAllGate` at the composition root — grants tables (`task_grants`, `account_baseline_rules` — accepted, §10), evaluator (baseline denies → task grants → default-deny for network header/secret reads, default-allow for basic actions during migration, tightening per rollout flag), redaction filter (§9 step 4: Authorization/Cookie/token-pattern masking even under header grants, `secrets:read` as the separate louder switch), approvals (`awaiting_approval` run state + park/expiry + `approval.requested|granted|denied` events — the state machine slot was reserved in Phase 2), navigation guard now driven by per-task allowlists instead of the env var, and MCP allowlists.

**Additional surfaces from the Phase 5 work:**

- **MCP tool allowlist per asset task** — `checkMcpCall` stops being permissive. Un-granted MCP tools are absent from the tool list entirely, not denied at call time (enforcement point (a), §10).
- **Asset write grants** tighten from "any path in the user namespace" to the per-task `path_glob`; reads stay open (§18.14).
- **Secret grants** — `secret_grants` enforced by the broker. Origin binding already shipped in S5b and is *not* a policy grant (it is a property of the secret), so it needs no migration here.
- **Tier-2 secrets** (§16) — user-wrapped DEK, Argon2id-derived key held client-side. A scheduled run needing a Tier-2 secret parks in `awaiting_approval` and reuses the approval machinery built in this phase. This is the subphase to cut if Phase 7 runs long (§18 open question 4).
- **`upload`/`download` capability grants** gating `page.upload` and download-to-asset.

**Additional tests:** un-granted MCP tool absent from an asset task's captured tool schema; asset write outside `path_glob` denied and traced; Tier-2 secret in a cron run → run parks, approval resumes it, expiry fails it; the **regression sweep** now includes the entire Phase 5 asset suite under a permissive-grants profile.

**System tests:**

- **Decision-table tests** on the evaluator alone: exhaustive grant × action matrix as data-driven cases (this is where most policy bugs die cheaply).
- Enforcement-point integration: (a) un-granted tool absent from the agent's tool list (assert against the replay adapter's captured tool schema); (b) compiled script calling an un-granted `ctx` method → verdict denial → deopt-or-fail per config → `policy.denied` traced; (c) redirect to off-grant domain aborted mid-run.
- Redaction: fixture endpoint returning `Set-Cookie` + bearer tokens; with `headers:read` granted but not `secrets:read` → masked in agent context (assert transcript) yet raw in the (opted-in) trace; with neither → `network.read(headers)` denied.
- Approval flow: purchase-class action on `fake-gram` with `requires_approval` → run parks, event emitted, test approves via API → run resumes and completes; expiry path → run fails `approval_expired`.
- **Regression sweep:** the *entire* Phase 2–6 system-test suite re-runs under a permissive-grants profile — proving the gate swap changed nothing when grants allow everything. This is the payoff of §0; if this sweep fails, the interface leaked somewhere.

## Phase 8 — UI (out of backend scope, listed for sequence)

React Flow editor over `workflows/edges/event_defs` — with **two node types in the palette** (browser, asset — §4) rendering different config panels and different validation (no schedule on an asset node) — including **cycle detection with an in-editor warning** (cycles are legal, bounded by the loop budget, but the user must see them) — run inspector over `trace_entries` (the inspector first — you'll want it while hardening), grants editor, approvals inbox.

**Asset-specific UI:** an asset browser (paths, versions, download, quota usage), inline PDF preview for rendered deliverables, an MCP server catalog with per-task tool selection, and the secrets manager (add/rotate, origin binding, Tier-1 vs Tier-2 choice with the trade-off stated plainly — Tier 2 means scheduled runs park for approval). **Packet schema authoring**: the node editor takes a free-text field description, compiled to JSON Schema by an LLM at save time (server-side, in the control-plane API); the engine only ever sees the resulting JSON Schema — no engine change. Both the emitting node and consuming nodes render/inject the declared fields. The backend API for all of it already exists as the same service endpoints the system tests exercise; keep it that way (system tests as living API contract).

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
