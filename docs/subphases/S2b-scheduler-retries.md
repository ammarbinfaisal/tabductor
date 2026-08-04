# S2b — Scheduler, retry policy, crash recovery

You are implementing subphase S2b. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 2 (scheduler/retry/crash-recovery bullets).
3. `docs/techical_plan.md` — §7 (Scheduler), §15 (Reliability).
4. `docs/subphases/ROADMAP.md`.

Existing code to reuse (read first): `packages/engine` (state machine, dispatch, StubExecutor,
watchdog), `packages/bus`, `packages/db`, testkit seed helpers. Extend `packages/engine`;
do not create a new package.

## Deliverables

1. **Scheduler** (in `packages/engine`):
   - `schedules` table already exists (`task_id, cron, tz, missed_policy, overlap_policy`);
     add columns via migration if missing: `last_fired_at`, `enabled`.
   - Use `croner` for cron+tz math. Loop: compute next due schedules from DB (poll ~1s or
     croner timers — DB is source of truth; timers must survive nothing, restart recomputes).
   - A due fire inserts a synthetic trigger event through the outbox (type
     `schedule.fired`, empty packet, no causation) routed to the task via the normal dispatch
     path — schedules are just an event source. Edge case: dispatch for scheduled fires must
     target the schedule's task directly (there is no edge row); reuse the dispatch/run-creation
     code path, not a parallel one.
   - **Missed-fire policy** on startup: compare `last_fired_at` to now; `skip` (default) just
     resets; `fire_once_catchup` fires exactly one synthetic event no matter how many ticks
     were missed.
   - **Overlap policy** at fire time: task has a live (`queued|running`) run → `skip` drops the
     fire (record via `system.schedule_skipped` event), `queue` allows at most 1 queued run
     behind the live one (depth >1 → drop).
   - **Injectable clock**: scheduler takes `now()` fn (default `Date.now`) so tests can fake time.

2. **Retry policy** (engine):
   - Task `limits_json.retry: { max, backoff_ms }`. On `failed` (NOT on packet-validation
     failures categorized as permanent, and later not on policy denials — leave a
     `permanent?: boolean` flag on failure results), create a NEW run row (attempt n+1) with the
     SAME `trigger_event_id`, delayed by backoff (use `runs.started delay` via a `not_before`
     column — add migration). Retried run does not re-claim dedupe (claim is per (task,event),
     already claimed; retries bypass claim by construction — make this explicit in code).
   - `run.failed` event fires per attempt; a final exhausted retry also fires
     `system.retries_exhausted`.

3. **Crash recovery** (engine):
   - Heartbeat: executor loop updates `runs.heartbeat_at` every ~2s while running.
   - On engine start: `running` runs with heartbeat older than a stale window →
     `failed` with error `engine_restart`; retry policy applies to them.

4. **System tests** (`tests/system/`; StubExecutor; fake clock where timing matters; name
   files by content — e.g. `scheduler.test.ts`, `retries.test.ts` — never by subphase):
   - Cron fires: schedule every-second cron; ≥2 fires observed; each fire → synthetic event →
     run for the task.
   - Overlap `skip`: long-running stub + 1s cron → exactly 1 live run; skipped fires recorded.
   - Overlap `queue(1)`: same setup → 1 running + max 1 queued.
   - Missed-fire: set `last_fired_at` 10 min back, start scheduler with `skip` → no fire;
     with `fire_once_catchup` → exactly 1 immediate fire.
   - Retry with backoff: stub fails twice then succeeds (make stub behavior attempt-aware, e.g.
     `fail_times: 2`) → 3 run rows, same trigger event, downstream triggered once, backoff gaps
     respected (assert not_before ordering, not wall-clock sleeps).
   - Crash recovery: mark a run `running` with stale heartbeat, boot engine → run failed
     `engine_restart`, then retried per policy.

## Style constraints (binding)
- Extend existing modules; no parallel dispatch path for schedules.
- Prefer less code; fake-clock plumbing should be one optional parameter, not a Clock interface
  with providers.
- New deps: `croner` only.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests must pass. Watch for timing-flaky tests — prefer DB-state polling with
deadlines over sleeps.

## Report back
What you built, deviations + why, commands + outcomes, flakiness. Do NOT git commit.
