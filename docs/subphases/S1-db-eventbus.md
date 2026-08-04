# S1 — DB layer + outbox event bus + dedupe + lineage + PolicyGate

You are implementing subphase S1 of the agentic browsing platform. Read, in order:
1. This file (authoritative task spec).
2. `docs/impl-phases.md` — "§0 policy precondition" and "Phase 1" sections.
3. `docs/techical_plan.md` — §6 (Event Bus), §14 (Data Model).
4. `docs/subphases/ROADMAP.md` — environment notes.

The repo already has: pnpm workspace, `packages/core` (ids/errors/config/logger),
`apps/testkit` (fixture sites, Chrome launcher, `createTestDb`), vitest wiring. Reuse them;
do not duplicate. Look at existing code style and match it.

## Deliverables

1. **`packages/db`** — **Drizzle ORM** (project standard; no kysely, no hand-written row types)
   - Schema declared in TS with `drizzle-orm/pg-core` in `packages/db/src/schema.ts`
     (per techical_plan §14, trimmed to columns S1–S2 need — do NOT invent extra columns,
     but DO declare all of these tables now so later phases only add):
     `workflows`, `workflow_versions`, `tasks`, `edges`, `event_defs`, `events`, `runs`,
     `run_dedupe`, `outbox`, `schedules`, `task_state`.
     Notes: `events(event_id uuid pk, type text, source_task_id, source_run_id, causation_id uuid null, packet jsonb, occurred_at)`;
     `outbox(id bigserial pk, event_id uuid, status text default 'pending', attempts int, next_attempt_at, dispatched_at)`;
     `run_dedupe(task_id, event_id, primary key(task_id,event_id))`;
     `runs` needs `status`, `mode_used`, `trigger_event_id`, `workflow_version_id`, `attempt int`,
     `heartbeat_at`, `started_at`, `ended_at`, `error` — the Phase-2 state machine will use them.
   - Migrations: generated SQL via `drizzle-kit generate` (checked into
     `packages/db/migrations/`), applied with drizzle's `migrate()`. Add a
     `pnpm --filter db generate` script. Type flow: use `$inferSelect/$inferInsert`; export
     the handful of row types other packages need from the package index.
   - `createDb(url) → { db /* drizzle instance */, pool, close() }` (node-postgres driver).
   - Testkit integration: `createMigratedTestDb()` helper (lives in testkit or db — pick the
     spot with less coupling; testkit must not import the world).

2. **`packages/bus`** — the outbox event bus (impl-phases Phase 1):
   - `publish(trx, event)`: inserts into `events` + `outbox` in the SAME transaction the
     caller passes (transactional outbox). Event shape per techical_plan §4/§6:
     `{ event_id, type, source_task_id?, source_run_id?, causation_id?, packet, occurred_at }`.
   - **Dispatcher**: polling loop (`FOR UPDATE SKIP LOCKED`, batch N, interval ~250ms) +
     Postgres `LISTEN/NOTIFY` wake-up latch (NOTIFY sent after commit by `publish` — use a
     trigger or post-commit notify; simplest correct approach wins). Delivers each outbox row
     to in-process subscribers (`subscribe(handler)`; handlers receive the full event row).
     Subscriber throws → row stays pending with `attempts+1`, exponential
     `next_attempt_at`; after `maxAttempts` (default 5) → status `dead_letter` and publish a
     `system.event_dead_lettered` event (guard against recursive dead-lettering of that event).
     All subscribers receive every event (it's a broadcast bus; consumers filter by type).
   - `claim(db, taskId, eventId)` dedupe helper → `'claimed' | 'duplicate'` (unique insert).
   - **Lineage**: `chainDepth(db, eventId, cap)` — recursive CTE over `events.causation_id`,
     capped.
   - `start()/stop()` lifecycle; stop drains in-flight delivery.

3. **`packages/policy`** — exactly the interface from impl-phases §0 (`PolicyGate`, `Verdict`,
   `AllowAllGate`) with one addition already agreed: `AllowAllGate.checkNavigation` enforces the
   `HARNESS_NAV_ALLOWLIST` env domain allowlist from core config (empty/unset = allow all).
   Keep TaskCtx minimal: `{ taskId, runId, grants?: unknown }` — Phase 7 will grow it.

4. **System tests** (`tests/system/`, real Postgres via testkit; name files by content —
   e.g. `outbox-bus.test.ts`, `lineage.test.ts`, `policy-gate.test.ts` — never by subphase):
   - Transactionality: publish inside a trx that rolls back → no event, no outbox row, never
     delivered. Publish inside a committed trx → delivered exactly once to a subscriber.
   - At-least-once + dedupe: reset a dispatched row to pending → handler called twice,
     `claim` admits once.
   - Dead-letter: always-throwing subscriber → after max attempts row is `dead_letter` and a
     `system.event_dead_lettered` event exists.
   - Lineage: build a 50-deep causation chain, `chainDepth` returns 50; cap 10 returns 10.
   - Throughput smoke: 10k events published (batched inserts fine) and fully dispatched < 60s.
   - Policy: `AllowAllGate` allows an action; navigation denied for a domain outside
     `HARNESS_NAV_ALLOWLIST` when set, allowed when unset.

## Style constraints (binding)
- Composition over abstraction. No EventEmitter inheritance, no generic "repository" layer —
  kysely queries live where they're used.
- Prefer less code; if dispatcher + publisher fit in one file cleanly, do that.
- New deps allowed: `kysely`, `pg`. Nothing else without justification.
- Timestamps: `timestamptz`, DB-generated where possible. IDs via core `newId` except
  `event_id` which is a raw uuid (used for dedupe pk).

## Verification
```
pnpm install && pnpm build && pnpm test
```
All existing S0 tests must still pass.

## Report back
What you built, schema decisions, deviations + why, commands run + outcomes, flakiness noticed.
Do NOT git commit — the reviewer commits.
