# S2a — Workflow engine core (state machine, graph eval, StubExecutor)

> **Historical build order, superseded in part by EC1 (migration `0007`).** The `edges` table
> this file describes no longer exists: events are workflow-version entities keyed
> `(version, type)`, tasks declare `emits`/`consumes`, and dispatch routes by type. Current
> model: `docs/event-centric-model.md`.

You are implementing subphase S2a. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 2.
3. `docs/techical_plan.md` — §4 (Core Concepts), §5 (Workflow Graph), §6 (Event Bus).
4. `docs/subphases/ROADMAP.md`.

Existing code to reuse (read it first, match its style): `packages/core`, `packages/db`
(Drizzle schema + migrations + inferred row types + `createMigratedTestDb`), `packages/bus`
(outbox publish/dispatcher/claim/chainDepth), `packages/policy`, `apps/testkit`. The scheduler, retries, and crash recovery are S2b —
NOT yours. Design so S2b can add them without reworking your code, but do not build them.

## Deliverables

1. **`packages/engine`**
   - **Executor contract**: `interface TaskExecutor { execute(run: RunHandle): Promise<RunResult> }`.
     `RunHandle` gives the executor: the run row, task row (prompt, mode, limits, scripted
     behavior), trigger event packet, and an `emit(type, packet)` function that (a) validates
     the packet against the task's `event_defs.packet_schema_json` (user-authored JSON
     Schema, validated with `ajv` — compile once per event_def, cache the validator),
     (b) publishes through the outbox in a transaction.
     `RunResult = { ok: true } | { ok: false, error: string }`.
     Boundary rule: user-authored packet schemas → ajv; everything else external (config,
     API input, tool args) → zod. External data is parsed, never cast.
   - **Run state machine**: statuses `queued → running → succeeded | failed | timed_out | cancelled`
     (leave room for `awaiting_approval` — status is text, no enum migration needed later).
     Every transition = one DB update + a system event (`run.completed`, `run.failed`,
     `run.timed_out`) published transactionally with it.
   - **Graph evaluation / dispatch**: a bus subscriber that, for each event, resolves
     subscribers via `edges (from_task_id, event_type) → to_task_id` against the LATEST
     workflow version; creates a `queued` run pinned to that version; uses `claim()` for
     `(task_id, event_id)` dedupe before creating the run. Then executes via the registered
     executor for the task's mode (registry = plain `Record<string, TaskExecutor>`).
   - **Loop budget**: before creating a run, `chainDepth(trigger)` vs workflow `max_hops`
     (column on `workflows`; add migration 002 if not present) → over budget: no run,
     publish `system.loop_budget_exceeded`.
   - **Run timeout watchdog**: periodic scan for `running` runs past `deadline`
     (task `limits_json.run_timeout_ms`) → mark `timed_out` + event. DB-driven, not setTimeout.
   - **StubExecutor**: reads scripted behavior from `tasks.limits_json.stub` (e.g.
     `{ emits: [{type, packet, delay_ms}], fail?: string, hang_ms?: number }`) — the permanent
     graph-testing executor.
   - **Engine lifecycle**: `createEngine(deps)` wires bus subscription + watchdog;
     `start()/stop()`. Composition root stays thin (an `apps/engine` can wait — tests wire
     directly; create `apps/engine` only if trivial).

2. **Seed helpers for tests** (in testkit or a test util — smallest coupling): create
   workflow + version + tasks + edges + event_defs rows concisely from a literal object.
   Tests will use this constantly; make it read well:
   `seedWorkflow(db, { tasks: {...}, edges: [...] })`.

3. **System tests** (`tests/system/`, StubExecutor + real PG + real bus; name files by
   content — e.g. `engine-graph.test.ts`, `engine-timeout.test.ts` — never by subphase):
   - Linear chain A→B→C: A's stub emits; B triggered with A's packet visible in B's run/trigger
     event; C runs; assert run rows + event lineage (`causation_id` chain).
   - Fan-out: one event → three subscriber tasks → three runs; one stub fails → siblings
     unaffected; `run.failed` emitted for the failure.
   - Cycle A→B→A with `max_hops=6` → exactly 6 runs then `system.loop_budget_exceeded`, no 7th.
   - Packet schema violation: stub emits packet missing a required field → emit rejected, run
     fails with clear error, no downstream run.
   - Timeout: hanging stub (`hang_ms` ≫ timeout) → `timed_out` within watchdog interval;
     `run.timed_out` event exists.
   - Dedupe: redeliver the same trigger event (reset outbox row) → no second run for the task.
   - Graph versioning: create v1 (A→B), start a run under v1, publish new version (A→C);
     in-flight run completes pinned to v1; its emitted event routes to C per v2.

## Style constraints (binding)
- Composition over abstraction; the executor registry is a plain object, transitions are
  functions not a StateMachine class.
- Prefer less code. Graph eval + dispatch will tempt you into a "planner" abstraction — resist;
  it's one subscriber function.
- New deps: `ajv` (packet JSON Schema validation). Nothing else without justification.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All S0/S1 tests must still pass.

## Report back
What you built, deviations + why, commands + outcomes, flakiness. Do NOT git commit.
