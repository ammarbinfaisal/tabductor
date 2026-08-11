# Agentic Browsing Platform — Incremental Implementation Plan (Backend-First)

**Version:** 0.6
**Companion to:** `techical_plan.md` (the design doc), `graph-compilation-llm.md` (decision kind, workflow store, graph compiler), `sharing.md` (shared workflows), `python-compute.md` (`mode=python`) and `event-centric-model.md` (events as entities). Section references (§) below point to the design doc. Resolved §18 decisions are folded in below and in the design doc itself.
**Ordering constraints (updated in 0.3):** "backend only" held until the tooling + event architecture stabilized — **that gate is passed** (Phases 1–2 done and committed). From S2c onward the UI ships incrementally per the **UI track** at the end of this document: each slice lands as soon as its backend prerequisite exists, starting with U0 which needs only S2c. The policy/permissions engine stays last. Testing remains backend system testing throughout — no UI tests.

**Changes in 0.2:** two node kinds (§4) — `browser` and `asset`. MCP moves off the browser node onto the asset node, joined by the asset store and LaTeX document generation. What was Phase 5 (MCP + secrets) is now **Phase 5 (asset node)**; the compiler and policy phases shift by one and gain kind-awareness.

**Changes in 0.3 (2026-08-09):** status verified against the repo — S2b is committed (`dc4de11`), not pending. "Phase 8 — UI at the end" is replaced by the **UI track** (slices U0–U6), each gated only on its backend prerequisite; the first visible UI is one subphase away. The **decision** node kind, the **workflow data store** (per-workflow Postgres schema + role pair), and the **graph compiler** (one prompt → checked graph) are specified in `graph-compilation-llm.md` and slot in as **S5g** and **S8** (see its §10); their UI lands as slices U3.5 and U6.

**Changes in 0.4 (2026-08-09):** platform observability (design-doc §17.2 — OTel + Grafana LGTM + pino logs) becomes a cross-phase concern: §0.5 below adds the telemetry package as subphase **SOb** (alongside S2c) and binds every later subphase to instrument what it builds. The design doc's Phase 5 "metrics dashboards" item is superseded — dashboards ship with SOb.

**Changes in 0.5 (2026-08-10):** two tracks are added, each specified in its own companion document.

- **Shared workflows** (`sharing.md`) — a read-only public link onto a workflow's graph, triggers, runs, events, opted-in packets and assets. Its only prerequisite is S2c, so it lands as **S2d + U0.5** and is independent of everything from S3a on. It is the first slice since U0 whose backend and UI can both ship immediately, and the sharing track section below sits between Phases 2 and 3 to reflect that.
- **Python compute** (`python-compute.md`) — `mode=python` on `kind=asset`, running an authored program in a Firecracker microVM to produce spreadsheets and other computed deliverables. It lands as **S5h** inside Phase 5, gated on S5a (the `kind`/`mode` discriminants) and S5d (somewhere for output files to go), and independent of S5e. The UI folds into U3.

**Changes in 0.6 (2026-08-10):** the wiring model changes — events become workflow-version-scoped
entities carrying a description prompt and an LLM-compiled packet schema, tasks declare
`emits`/`consumes` by type, and the `edges` table is gone. Specified in `event-centric-model.md`,
landing as **EC1 + U1** in the event-centric track between the sharing track and Phase 3. Three
passages ripple backwards and are rewritten in place rather than annotated: Phase 2's graph
evaluation and packet validation, S2d's visibility projection, and U2's packet-schema authoring
item (which shipped early, at publish rather than at save). The UI track's old **U1 — run
inspector** is renumbered **U1.5** so U1 can name the editor redesign; nothing about the
inspector's scope or prerequisites changes.

---

## Status — as of 2026-08-11 (verified against the working tree)

| Subphase | Scope | State |
|---|---|---|
| S0 | Monorepo scaffold, core, testkit (fixture sites, CDP launcher, test DBs) | **done** — `15914a0` |
| S1 | Drizzle data layer, outbox bus, dedupe, lineage, PolicyGate/AllowAllGate | **done** — `7e2b7fd` |
| S2a | Engine core: run state machine, graph dispatch, packet validation, loop budget, StubExecutor | **done** — `f2e2f23` |
| S2b | Scheduler (cron/tz, missed/overlap, queue depth), retries, crash-recovery watchdog | **done** — `dc4de11` (scheduler/retries/crash-recovery + migrations `0003`/`0004`) |
| S2c | Next.js + tRPC control-plane API | **done** |
| SOb | `packages/telemetry`: OTel + pino + bus traceparent + engine instrumentation (§0.5) | **done** |
| U0 | First UI: graph editor, schedules, stub scripting, runs table, event feed | **done** — editor surface since replaced by U1 |
| S2d | Shared workflows: share model + public read API | **done** — `7dfe920` |
| U0.5 | Public workflow view + owner-side share management | **done** — `e1e4289` |
| EC1 | Event-centric model: event entities, consumes routing, publish-time schema compiler (`event-centric-model.md`) | **done** — migration `0007` |
| U1 | Editor redesign: declarative panels + derived map, prompt-only authoring | **done** — `DESIGN.md` locked ("Ruled Ink"), React Flow removed |
| S3a | Browser driver + navigation guard + trace recorder + blob store (`packages/browser`) | **done** — migration `0008` |
| S3b–S7, S5g, S5h, S8 | pool/observer/limits, agent, asset, python compute, store+decision, compiler, policy, graph compiler | not started |

What exists as code: `packages/{core,db,bus,engine,policy,telemetry,browser}` +
`apps/{engine,web,testkit}` + `tests/system` — 122 tests in 29 files. The whole workspace typechecks clean (`tsc`) and lints
clean (`pnpm lint`). `docker compose up -d` brings up Postgres, applies migrations, and runs both
the engine and the control plane on :3000; `docker compose up -d postgres` is the tests-only
subset. Credentials are compiled in as defaults, so a clean checkout needs no environment. If
every DB-backed file fails at SCRAM auth *before any test logic runs*, that container is down or a
stale `PG*` variable is set in the shell — an environment problem, not a regression. (This
replaced an earlier setup that connected as the OS user to a system Postgres on 5432, which
broke as soon as an unrelated project took that port.)

Phases 1 and 2 are therefore complete, and the first UI slice is on screen. The `tasks.kind`
column (§4) does not exist yet and is added in **S5a** below — it is a nullable-defaulted `text`
column alongside the existing `mode`, so no backfill and no rewrite of S2a's executor registry,
which already keys on a discriminant. Until then the node kind lives in the graph document only,
which is enough for the two things that read it today: the editor palette and the
"a schedule may not bind to an asset node" check at publish.

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

## 0.5 Cross-phase platform observability (SOb — design doc §17.2)

Same shape as §0: a thin interface built now so nothing needs retrofitting. Platform observability
(operator-facing OTel traces/metrics/logs → Grafana LGTM) is specified in design-doc §17.2; this
section is its build placement.

**SOb — `packages/telemetry`, built alongside S2c** (it instruments the engine that already exists
and the API being built; every subphase after it arrives instrumented):

- Init module used **only by composition roots** (`apps/engine`, `apps/web`, `apps/renderer`);
  packages receive tracer/meter/logger by injection, exactly like `PolicyGate`. **No-op when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is unset** — zero sockets, zero background work; this is the CI
  and docker-less-dev mode (this machine runs without Docker; the `grafana/otel-lgtm` container
  runs wherever Docker exists).
- pino logger factory (JSON, child loggers bound with `run_id`/`task_id`/`trace_id`, OTLP bridge);
  lint rule banning `console.log`.
- **Bus propagation:** `traceparent` column on `outbox`/`events` (one additive migration); emit =
  producer span, dispatch = child consumer span, redeliveries/retries = span links (§17.2 rule 3).
- Instrumentation of what already exists: outbox lag/depth/dead-letters, dedupe drops, scheduler
  fire lag and fire results, run outcomes/durations, crash recoveries — the §17.2 metrics
  catalogue rows that have backing code today, under their **binding names**.
- Grafana dashboard JSON provisioned in-repo (engine-health + security-signals boards first;
  cost and fleet boards gain panels as their metrics appear).

**Standing rule for every subsequent subphase:** instrument what you build, using the §17.2
catalogue names — S3a/S3b: endpoint health, queue wait, disconnects, resource-limit aborts;
S4a/S4b: LLM tokens/cost, step budgets; S5b: `secret_fills_total`; S5c: MCP call metrics;
S5e: render duration + sandbox kills; S5g: store query duration + `store_sql_rejected_total`;
S6a–c: deopts, promotions/demotions; S7: `policy_verdicts_total` gains real rule labels.
A subphase whose metrics are missing is incomplete the same way one without tests is.

**Content rules are binding here too:** telemetry carries identifiers, durations, sizes, and
outcomes — never page content, packets, prompts, SQL text, secrets, or CDP URLs; navigation
appears at domain granularity only (§17.2). Telemetry is **not** an assertion surface — traces
and events remain the system-test ground truth; the one telemetry test is the disabled-mode
no-I/O smoke test.

---

## Repository & runtime layout

TypeScript monorepo (pnpm workspaces). One deployable process in early phases (`engine`), splitting later only if needed.

```
/packages
  /core        — shared types, ids, errors, config loader, zod schemas
  /db          — Drizzle schema (drizzle-orm/pg-core), drizzle-kit migrations, outbox helpers
  /bus         — event bus: publish (outbox), dispatcher, dedupe, lineage
  /engine      — workflow engine: graph eval, run state machine, scheduler
  /policy      — PolicyGate interface + AllowAllGate (real evaluator in Phase 7)
  /telemetry   — OTel init (composition roots only), pino logger factory,
                 metric registry with the §17.2 binding names (SOb, §0.5)
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

- `docker-compose.yml` (built as the root compose file rather than a separate `docker-compose.test.yml`, since dev and test want the same services): Postgres 16, plus Grafana LGTM behind a `telemetry` profile. Since S2c/U0 it also runs the application itself — a one-shot `migrate` service both app services wait on, `engine` (the composition root) and `web` — so `docker compose up -d` is the whole bring-up and `docker compose up -d postgres` is the tests-only subset. Chromium and the fixture sites are deliberately **not** services — the testkit launches headless Chrome per test with `--remote-debugging-port` on a throwaway `--user-data-dir` (this *is* your BYO-CDP simulator, connected to exactly the way production connects to a user's endpoint) and serves the fixture sites in-process. See `infra/README.md`.
- **Fixture sites** (`apps/testkit/sites/`): small deterministic HTML apps served locally — `fake-tweets` (a timeline page with data attributes, plus a `POST /admin/add-tweet` endpoint so tests can inject "new tweets" mid-run), `fake-gram` (a form that records submissions), `mutator` (same page, but layout switchable via query param — used to force deopts in Phase 6), `slowpoke` (configurable latency/timeouts). Fixture sites are the backbone of system testing: real Chromium, real CDP, zero external network.
- **LLM replay adapter**: the `agent` package's LLM client has `mode: "live" | "record" | "replay"`. `record` runs against the real API and writes the full transcript (prompts, tool calls, results) to a fixture file; `replay` serves the recorded tool-call sequence deterministically. System tests run in `replay` (fast, free, deterministic); a small separate `live-eval` suite runs `live` nightly/manually to catch model drift. Never let CI depend on live LLM calls.
- Test DB lifecycle: each system test gets a schema-per-test (template database clone) — parallel-safe, no shared-state flakes.
- **Fake MCP server** (Phase 5): stdio MCP server in testkit exposing `echo` and an image-stub tool that returns a fixed PNG — deterministic, no external calls, exercises the client, the budget, and the untrusted-result wrapping.
- **LaTeX fixtures** (Phase 5): a happy-path `.tex`, a malformed `.tex` (missing package, stray `&`) for the correct-and-retry path, and a **hostile corpus** (`\write18`, `\input{/etc/passwd}`, macro loop, memory bomb) — table-driven, extended whenever someone thinks of a new escape, exactly as with the `isolated-vm` corpus in Phase 6. PDF comparisons normalize timestamps and document IDs before asserting.

---

## Phase 1 — State store + Event bus ✅ **DONE** (S1)

**Goal:** durable events with at-least-once delivery, dedupe, and lineage. No tasks yet — publishers and consumers are test doubles.

**Build:**

- Migrations for: `events`, `run_dedupe`, `outbox`, plus the skeleton tables the engine will need (`workflows`, `workflow_versions`, `tasks`, `edges`, `event_defs`, `runs`) — schema per §14, even if some columns go unused for a phase or two. Migrating early beats renumbering later. As built, `edges` was dropped and `event_defs` re-keyed to `(version, type)` at EC1, with `task_emits`/`task_consumes` taking over the wiring (migration `0007`).
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

## Phase 2 — Workflow engine + scheduler (stub executors) ✅ **DONE** (S2a `f2e2f23`, S2b `dc4de11`, S2c)

**Goal:** the full trigger→dispatch→run→emit loop working *without a browser*. Tasks are executed by a **StubExecutor** that reads a scripted behavior from the task definition (`emit these events with these packets after this delay / fail / hang`). This is deliberate: the engine's correctness must be testable independently of browsers and LLMs, and the StubExecutor remains permanently useful for testing graphs.

**Build:**

- **Task executor abstraction:** `interface TaskExecutor { execute(run: RunHandle): Promise<RunResult> }` — implementations: `StubExecutor` (now), `AgentExecutor` (Phase 4), `CompiledExecutor` (Phase 6). Registered per task `mode`.
- **Run state machine** (§4): `queued → running → succeeded|failed|timed_out|cancelled` (approval state arrives in Phase 7). Transitions are DB writes + system events (`run.completed`, `run.failed`, `run.timed_out`). Run-level timeout enforced by the engine (watchdog scanning `running` runs past deadline — not `setTimeout`, so it survives restarts).
- **Graph evaluation:** on event delivery, resolve subscribers by type against the *latest* workflow version — one probe of `task_consumes (workflow_version_id, event_type)`; runs pin the version they started under (`runs.workflow_version_id`). Built first against an `edges` table and re-pointed at `task_consumes` by EC1; version pinning, dedupe and the loop budget were untouched by that change (`event-centric-model.md` §2).
- **Packet validation:** `event_defs.packet_schema_json` — one schema per `(version, event type)`, compiled at publish and validated under ajv at emit; invalid → emit fails, run fails with a clear error. The emit is additionally gated on the task declaring the type in `emits`.
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

**Exit:** the events architecture is done and system-tested. This was the "basic tooling + events ready" gate, and it is passed — per the 0.3 ordering, the **UI track** starts the moment S2c lands: U0 renders exactly the tables and events this phase produces.

## Sharing track — S2d + U0.5 (gated on S2c only)

**Goal:** an unguessable link that lets anyone watch a workflow's graph, triggers, runs, events, opted-in data packets and produced assets — live or historical. Full design in `sharing.md`; §16 Threats 13–17 and §17.3 in the design doc.

This sits here rather than at the end because it needs nothing that does not already exist. Everything it renders — graph, schedules, runs, events, packets, lineage — is data S2a/S2b produce and S2c already serves to the owner. It is off the Phase 3–8 critical path entirely and can be interleaved wherever it fits.

### S2d — share model + public read API

- **Migration:** `workflow_shares(id, workflow_id, token_sha256 unique, token_prefix, created_at, revoked_at)`; `event_defs.public boolean not null default false`.
- **Graph document:** `graph.events[].public` (default `false`), projected by `publishVersion` into `event_defs.public` keyed `(version, type)`, exactly as packet schemas and schedules already are. This is what makes visibility versioned, and what makes a newly added event arrive private without a check having to say so. (Shipped on the per-emitter `GraphTask.emits[].public` and re-homed to the event entity at EC1; the migration collapsed the old rows with `bool_or`, preserving the union semantics the read models already enforced.)
- **Public read models** in `packages/engine/src/queries.ts` — `publicGraph`, `publicRunList`, `publicEventList`, `publicEventGet` — each taking a **required** `workflowId` and an explicit `publicTypes` set. **They filter in SQL:** a private packet is never selected, so no router or component bug can leak one. This is the subphase's central rule and its central test.
- **Error-class derivation:** `runs.error` free text never leaves the owner's view; the public read model maps it to a bounded class (`timeout`, `retries_exhausted`, `engine_restart`, `packet_invalid`, `loop_budget_exceeded`, `no_executor`, `sandbox_kill`, `policy_denied`, `other`).
- **Share procedures** (`create`/`rotate`/`revoke`/`list`) and a **public tRPC router** with its own `{db, share}` context that cannot reach `listWorkflows` — which today ignores its `userId` argument and returns every workflow in the database.
- Rate limiting per share and per IP; hard page-size caps; the existing depth cap on the lineage CTE.
- Metrics: `share_views_total{result}`, `share_asset_reads_total{outcome}`.

**System tests:** a private event type's packet is absent from the *query result*, not merely from the response (assert on the read model directly); publishing a version that adds a node leaves it private; marking an event public then re-publishing without the flag makes it private again; revoked, unknown and malformed tokens are indistinguishable; a run that failed with a content-bearing error string exposes only its class; lineage across a private hop keeps the hop and drops the body; page-size caps hold against a hostile `limit`.

### U0.5 — public workflow view

Route group `/s/[token]`: graph, runs table, event feed, event detail with lineage. Server-rendered through `createCaller` like the owner's pages, polling at 2s with `usePolling` — no websockets, for U0's reason. `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` on every public route.

**Reuse rather than fork**, or the two views will drift: the public view and the editor both render `derived-map.tsx` over a topology derived from `emits`/`consumes` and both render the same event cards, and `runs-table.tsx`/`event-feed.tsx` are parameterized by the fetcher they call. Owner-side share management (create with a visibility preview, rotate, revoke) lands on the workflow page. No UI tests, as ever — S2d's tests are the contract.

**Exit:** a link you can send someone, showing a workflow running, with exactly the packets you chose and nothing else.

## Event-centric track — EC1 + U1 (full design in `event-centric-model.md`)

### EC1 — event entities, consumes routing, publish-time schema compiler ✅ **DONE**

The wiring model change: events become workflow-version-scoped entities
(`event_defs` re-keyed to `(version, type)`, carrying the author's description prompt, the
compiled `packet_schema_json`, the carry-forward `prompt_hash`, and S2d's `public` flag);
tasks declare `emits`/`consumes` by type (`task_emits`/`task_consumes`); the `edges` table
is dropped (migration `0007` backfills consumes from it first) and dispatch routes by one
probe of `task_consumes(workflow_version_id, event_type)`. `publishVersion` takes an
injected `SchemaGenerator`, reuses unchanged schemas via the hash, gates everything under
ajv strict (+formats), and returns a per-event compile report; failure writes nothing.
The model-backed implementation (bounded self-repair) lives behind
`@tabductor/engine/ai` over the Vercel AI SDK, constructed only in the web composition
root off `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Scriptless stub tasks emit sampled packets derived from their
compiled schemas, so a published graph runs with nothing hand-scripted.

### U1 — the declarative editor (replaces U0's canvas) ✅ **DONE**

The client stops accepting JSON anywhere: no packet schemas, no stub scripts. Three
panels — Events (description prompts, visibility, read-only compiled schemas), Nodes
(prompts, trigger/emit chips), and a derived read-only map of the bipartite topology
(dependency-free SVG; React Flow removed) — plus the compile report in the publish flow.
Designed through the design track (JOURNEY.md → DESIGN.md → component specs) rather than
grown from U0's inspector.

As built: `JOURNEY.md` and a locked `DESIGN.md` ("Ruled Ink" — light, editorial, ink-blue
events against amber nodes) sit at the repo root with their component specs and contrast
validator under `.design-foundations/`; `apps/web/src/app/globals.css` is the token block
plus everything derived from it, and no component names a raw colour. `@xyflow/react` is
gone from `apps/web`, along with `json-field.tsx`, `stub-panel.tsx` and
`task-config-panel.tsx`. Compile failures render as a per-event report with a deep link
into the offending description; the S2d visibility-diff confirm survives, now reading
`graph.events[].public`. The hook policy held — panel state (menus, delete confirms, the
deep-link flash) lives in the editor store's `ui` slice, not in `useState`.

Deliberately still open, because both belong to whoever runs the app rather than to this
slice: `ANTHROPIC_API_KEY` is unset in `docker-compose.yml`, so a compose deployment
publishes only carry-forward schemas until it is passed through; and the long-lived dev
database is still at migration `0006` — `0007` has been exercised against throwaway
databases only.

---

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
- **Agent loop:** system prompt (task prompt + the compiled schema of every type the task emits + the trigger event's packet fields, injected per that event's declared schema + tool docs) → tool-call loop → step budget + run timeout from the engine. Every LLM call (prompt hash, tokens, tool calls) → trace.
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
- **Public asset resolution** (required by S2d, `sharing.md` §4.4): an asset is publicly readable **iff** a public packet under a live share references it. Implement the derivation query and the `/s/<token>/assets/<id>` blob route with its headers (`Content-Disposition: attachment`, `nosniff`, `CSP: sandbox`, MIME allowlist) here rather than leaving them to be bolted on — visibility that is derived cannot fall out of sync, and visibility that is bolted on will.

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

### S5h — Python compute mode (`mode=python`)

Gated on S5a (the `kind`/`mode` discriminants) and S5d (somewhere for output files to land). **Independent of S5b/S5c/S5e** — it touches no secret, no MCP server and no renderer — so it may land before or after them. Full design in `python-compute.md`; §13.6 and Threats 18–22 in the design doc.

- **`(kind, mode)` tool registry.** S5a already re-keys the *executor* registry; this re-keys the *tool* registry to match. `(asset, ai)` keeps `mcp.*`/`assets.*`/`emit`; **`(asset, python)` gets nothing at all**. That is the whole security argument for putting Python on the asset kind: the job has no host bridge, so it cannot reach `mcp.*` even though it shares a kind with them.
- **Constraint extension:** S5a's named `tasks_kind_mode_check` grows `mode IN ('ai','compiled','python')` and `NOT (kind <> 'asset' AND mode = 'python')`. Rejected at save time by the control plane, re-asserted by the check.
- **Graph document:** `GraphTask.code = {language, source}` and `GraphTask.runtime = {image, packages[], inputs{assets[], tables[]}}`, projected into `tasks.code_source`/`code_sha256`/`runtime_json`. Code changes go through `publishVersion`, never `updateTask` — runs pin their version, and `code_sha256` feeds the task content hash (`graph-compilation-llm.md` §6.3). Publish validates `packages` against the committed image manifest.
- **`apps/pyrunner`:** a composition root on an internal, egress-less compose network reachable only by `engine`. Two backends behind one interface — `firecracker` (default when `/dev/kvm` is present; the only one that is a security boundary) and `subprocess` (labelled not-a-boundary in code, docs and its startup log; refuses to start without `PYRUNNER_ALLOW_UNSAFE_BACKEND=1`).
- **The sandbox:** microVM under `jailer`, **no network device configured**, `--no-api` static boot, read-only rootfs, one fresh ext4 scratch drive as the only channel, no vsock, 1 vCPU with memory/CPU/wall-clock caps. Scratch built with `mke2fs -d` and read back with `debugfs -R rdump` — both userspace, so the host never loop-mounts an image written by untrusted code.
- **`PythonExecutor`** in the engine: resolve declared inputs → call the runner → extract outputs → write asset versions under the write-grant glob → **publish emits host-side** through the same `emit` path every other executor uses, so packet validation, dedupe, loop budget and the outbox apply unchanged. Sandbox kills fail the run *permanently*; program errors surface `stderr` and retry per policy.
- Metrics: `pyrun_jobs_total{outcome}`, `pyrun_duration_seconds{outcome}`, `pyrun_vm_boot_seconds`, `pyrun_sandbox_kills_total{reason}`, `pyrun_output_bytes`.

**Tests — a hostile corpus in the S5e style, table-driven, extended whenever someone thinks of a new escape:** network attempts of every flavour (`socket`, `urllib`, `requests`, raw fd); `subprocess`/`os.system`; fork bomb against the pid limit; memory bomb; infinite loop against the wall clock; writes outside `/job/out`; a symlink pointing out of the scratch dir; output exceeding the byte and file-count caps; `../../etc/passwd` as an output filename; a 100 MB single-line `emits.jsonl`. Contract tests: emits validated host-side against the declared packet schema, a malformed emit failing the run; a sandbox kill failing permanently with no retry; a task declaring a package outside the manifest rejected at publish; `kind=browser, mode=python` rejected at publish and by the check constraint. Happy path: a fixture program producing a byte-stable `.xlsx` after timestamp normalisation (same rule as the PDF fixtures).

**Sandbox suite gating:** the hostile corpus runs on the `firecracker` backend only and **skips with a visible message** when `/dev/kvm` is absent — never silently, and never by re-pointing at the subprocess backend, which would turn the sandbox suite into a suite that tests nothing.

**E2E:** browser node scrapes fixture pricing → decision or stub node filters → python node writes `/reports/pricing-<date>.xlsx` with a pivot and a chart → emits `report.ready {asset_ref}` → browser node uploads it to `fake-gram`.

**Exit:** both node kinds work, exchange data only through validated packets, the tool registries are provably disjoint, and a workflow can compute.

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

## The UI track — incremental, gated only on prerequisites (replaces "Phase 8 — UI")

The 0.2 ordering ("UI after everything") is retired. Its actual rationale was "don't build UI
on an unstable event architecture," and that architecture is now stable and system-tested
(Phases 1–2 done). From here, **the UI ships in thin slices, each landing as soon as — and no
later than — its backend prerequisite**. You see a working UI one subphase from today: U0's
only prerequisite is S2c.

Two standing rules, which are what make the slices cheap:

1. **Every slice consumes the same tRPC procedures the system tests exercise.** No UI-only
   endpoints, no business logic in `apps/web` beyond composition (the S2c stack rules:
   thin Next.js, zod end-to-end, no hooks beyond `useMountHook`). If a slice needs data no
   endpoint serves, that is an S2c-family backend change with a system test — the UI never
   fills the gap itself. System tests stay the living API contract.
2. **Still no UI tests** (doctrine unchanged). A slice is verified by the backend tests of
   the endpoints it renders, plus eyes.

| Slice | Lands with | What you see on screen | Prerequisite |
|---|---|---|---|
| **U0 — first UI** | **S2c** | Workflow list; schedules editor (cron/tz/missed/overlap); runs table with live status; event feed with lineage links. Author a graph, cron- or hand-trigger it, and watch runs and events flow — before any browser exists. As shipped it also carried a React Flow canvas over `workflows/tasks/edges/event_defs`, a packet-schema JSON field and a StubExecutor scripting panel; **U1 removed all three** and this row no longer describes them. Cycle visibility survived the move: cycles are legal, bounded by the loop budget, and annotated on the derived map's back-edges. | S2c only |
| **U0.5 — public view** | **S2d** | `/s/<token>`: the graph, its schedules and triggers, the runs table and the event feed, read-only, for anyone holding the link — with packet bodies shown only for event types the author marked public, and a bounded error class instead of error text. Owner-side share management: create with a visibility preview, rotate, revoke. Reuses U0's components via an injected fetcher rather than forking them. | S2d only |
| **U1 — declarative editor** | **EC1** | The editor stops being a canvas: an Events panel (one description prompt per event, its visibility switch, and its compiled schema as a read-only field list), a Nodes panel (prompt, trigger chips ⏰/◈, emit chips, limits), and a derived read-only map of the bipartite topology with the loop budget annotated on back-edges. Publishing renders a per-event compile report. No JSON anywhere in the client; React Flow removed. | EC1 only |
| **U1.5 — run inspector** | S3a–S3b | The debugging surface, deliberately *before* the agent exists (you'll want it while hardening Phase 3): per-run timeline of navigations, actions, and network entries with policy verdicts, screenshots via `blob_ref`, resource-limit and disconnect failure detail; endpoint health panel for `cdp_endpoints`. | S3a (traces), S3b (observer/pool) |
| **U2 — agent visibility** | S4a–S4b | Inspector gains LLM calls (prompts, token counts, tool-call sequences) and emitted-packet views. Packet-schema authoring is **not** part of this slice — it shipped with EC1/U1, on the event rather than the emitting node, compiling at publish so the schema versions with everything else; the derived map and the Events panel already render the declared fields to both sides. | S4b |
| **U3 — asset surfaces** | S5a–S5h | Asset browser (paths, versions, download, quota usage), inline PDF preview for rendered deliverables, `.xlsx` download, MCP server catalog with per-task tool selection, secrets manager (add/rotate, origin binding, Tier-1 vs Tier-2 with the trade-off stated plainly — Tier 2 parks scheduled runs for approval). Asset node's config panel becomes real, including a **read-only Python source viewer with cross-version diff** — the same argument §11 makes for compiled scripts: users must be able to see what will run. | S5b–S5e, S5h as each ships |
| **U3.5 — decision + store** | S5g | Palette gains the **decision** node; workflow store browser (tables, row counts, schema per version) and a read-only query console running the *same fenced read path* as `store.query`; store-schema migration diffs (additive/destructive) shown at publish. | S5g (`graph-compilation-llm.md` §10) |
| **U4 — compiler** | S6a–S6c | Compiled-script viewer with version diff (users must be able to inspect what will run against their browser, §11), deopt timeline in the inspector, promotion/demotion state on nodes, and **LLM-cost-per-run, ai vs compiled** — the product's core claim, on screen from the day it's measurable. | S6c |
| **U5 — policy** | S7 | Grants editor per task, account-baseline editor, approvals inbox (park / approve / expiry countdown), redaction settings, storage opt-outs. | S7 |
| **U6 — one-prompt authoring** | S8 | Intent prompt → draft graph rendered in the editor; compile-report panel (per-check pass/warn/fail — the same surface U1 already renders for per-event schema compilation, widened to S8's graph checks); **proposed-grants review checklist** with diffs on recompile — the approval flow that turns proposals into `task_grants`. | S8 (`graph-compilation-llm.md` §4–5) |

Sequencing note: slices are ordered by prerequisite, not priority — U1.5 (inspector) is the one
worth pulling as early as its data exists, since it is the debugging surface for everything
after it. U0, U0.5 and U1 are done; U1.5 is next, and half its prerequisite is in — S3a
produces the traces and the screenshots it renders, S3b the endpoints and network entries.

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
