# S5a — `tasks.kind` discriminant, AssetExecutor skeleton, kind constraints

You are implementing subphase S5a. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — S5a section under Phase 5.
3. `docs/techical_plan.md` — §4 (two discriminants; why kinds are a security boundary), §5
   (kind constraints).
4. `docs/graph-compilation-llm.md` — §2.1 only (the kind taxonomy this subphase must not
   paint into a corner: `decision` arrives in S5g).
5. `docs/subphases/ROADMAP.md` — node-kinds block (binding from this subphase on).

Existing code to reuse (read first): `packages/db` (schema + migrations), `packages/engine`
(executor registry — S2a already dispatches through a discriminant; `StubExecutor`),
`apps/web` (S2c `publishVersion` + zod schemas). MCP, asset store, LaTeX, secrets are
S5b–S5e — NOT yours. This subphase is deliberately plumbing-only: after it, a `kind=asset`
task can be defined, triggered by an event, and executed by a skeleton executor.

## Deliverables

1. **Migration (`packages/db`, additive):**
   - `tasks.kind text NOT NULL DEFAULT 'browser'` — existing rows become browser tasks, no
     backfill. `mode` untouched and orthogonal (§4).
   - Named check constraint `tasks_kind_check CHECK (kind IN ('browser','asset'))` — named
     so S5g extends it to `'decision'` with a single drop-and-re-add ALTER; leave a
     `-- S5g adds 'decision'` comment in the schema.
   - Named check constraint `tasks_kind_mode_check CHECK (NOT (kind = 'asset' AND mode = 'compiled'))`
     (§11: asset tasks are never compiled).
   - Schedule→asset is a cross-table rule, so a CHECK cannot express it: add a constraint
     trigger on `schedules` (insert/update) rejecting a task whose `kind = 'asset'`. Write
     it as a deny-on-asset, not an allowlist — `decision` (S5g) is schedulable by design
     and must not require touching this trigger's shape, only nothing (asset stays the only
     denied kind).

2. **Executor registry re-key (`packages/engine`):** lookup key changes from `mode` to
   `(kind, mode)`. Existing registrations move under `kind='browser'` unchanged
   (StubExecutor, ScriptedBrowserExecutor, AgentExecutor per their current modes). This is
   a lookup-key change, not a rewrite — if it turns into one, stop and re-read S2a's
   registry. Missing registration at dispatch → run fails with a typed
   `no_executor_for(kind, mode)` error, traced.

3. **Write-time constraint enforcement (`apps/web`, S2c API):** `publishVersion` (and any
   schedule mutation procedure) rejects, with typed errors: (a) a schedule bound to a
   `kind='asset'` task; (b) `kind='asset'` with `mode='compiled'`. Zod/refinement at the
   API boundary — the DB trigger and checks from deliverable 1 are the backstop for direct
   inserts, not the primary UX (§5: reject at save time, not dispatch time).

4. **`AssetExecutor` skeleton (`packages/engine`):** registered for `(asset, ai)`. Runs the
   same scripted-behavior contract as `StubExecutor` (behavior from the task definition:
   emit these events with these packets / fail / hang) so kind plumbing is fully testable
   before any MCP or LaTeX exists. S5c/S5d replace its innards; its executor-contract
   surface is what they fill in — keep it one file.

5. **System tests** (`tests/system/`, content-named, e.g. `kind-constraints.test.ts`):
   - `publishVersion` with a schedule on an asset task → typed error; nothing persisted.
   - `publishVersion` with `kind=asset, mode=compiled` → typed error.
   - Direct SQL insert of a schedule on an asset task → rejected by the trigger; direct
     update flipping an asset task to `mode='compiled'` → rejected by the check.
   - Event emitted by a browser task triggers an asset task → run executes under
     `AssetExecutor` (assert via trace/run row), packet fields visible to it.
   - Dispatch to a `(kind, mode)` pair with no registration → typed failure, run failed.
   - **The entire Phase 2 suite re-runs green** — the re-key must not disturb browser-task
     dispatch (no test edits beyond registry wiring; if a Phase 2 test needs changing,
     that's a finding to report, not to silently fix).

## Style constraints (binding)
- No new packages, no new deps. Changes live in `packages/db`, `packages/engine`, `apps/web`.
- `kind` is a column and a registry key — not a class hierarchy. No BaseExecutor inheritance
  tree; the registry stays a map.
- Do not add `mcp.*`/`assets.*` tool names anywhere yet — S5c owns the asset registry and
  its isolation test.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests stay green; run twice. Verify the migration applies cleanly on a database
holding pre-S5a rows (the template-clone helper covers this — assert existing seeded tasks
read back as `kind='browser'`).

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Do NOT git commit.

> **Built, with deviations.** Migration `0010_parallel_killraven`: `tasks.kind text NOT NULL
> DEFAULT 'browser'`, `tasks_kind_check`, `tasks_kind_mode_check` (all three generated by
> `drizzle-kit generate` from a `check()` builder now declared beside the column in
> `schema.ts`, matching the `RUN_STATUSES`/`MISSED_POLICIES` closed-domain pattern rather
> than staying a graph-document-only enum), plus a hand-appended constraint trigger
> (`tabductor_schedule_deny_asset_kind` on `schedules`, same hand-SQL-after-generate pattern
> as migration `0001`'s outbox `NOTIFY` trigger).
>
> Registry re-key: `executorKey(kind, mode) => "${kind}:${mode}"` in `executor.ts`, used at
> the one dispatch site (`engine.ts`) and every registration site (`apps/engine/src/main.ts`,
> `tests/system/agent-support.ts`, `tests/system/scripted-support.ts`; `engine-support.ts`'s
> `startRig` grew an optional `executors` override so `kind-constraints.test.ts` can register
> `AssetExecutor` without a new rig file). The no-executor run failure message keeps its old
> `"no executor registered"` prefix (`public-read.ts`'s `ERROR_CLASS` SQL still matches it)
> and appends the spec's `no_executor_for(kind, mode)` identifier after it, rather than
> replacing the prefix outright.
>
> `AssetExecutor` (`asset-executor.ts`) is `{ execute: runStubScript }` — `runStubScript` is
> `StubExecutor`'s former inline body, extracted and exported so both registrations share one
> scripted-behavior implementation instead of forking it; not a base class, a shared function
> two one-line `TaskExecutor` objects both point at. Registered for `(asset, ai)` in
> `apps/engine/src/main.ts` unconditionally, alongside `(browser, stub)` — it needs no live
> key or endpoint gate, for the same reason `StubExecutor` doesn't.
>
> `checkGraph` gained the `mode=compiled`+`kind=asset` reject next to the existing
> schedule/asset reject (the graph document's zod enum already carried `kind` since U1; this
> subphase's write-time check was the one piece actually missing). `publishVersion` now
> writes `kind` into the `tasks` insert; `readGraph` and `public-read.ts`'s `publicGraph` now
> read `kind` from the `tasks.kind` column instead of parsing it out of `graph_json` — both
> call sites' surrounding comments said this parsing was a stopgap "until the column arrives
> at S5a," so this subphase retired it rather than leaving the column unread by its own
> consumers. `graph.ts`'s `NODE_KINDS`/`NodeKind` now re-export `@tabductor/db`'s
> `TASK_KINDS`/`TaskKind` instead of restating the tuple, so the document's enum and the DB
> check can't drift; every existing import of `NODE_KINDS`/`NodeKind` (`public-read.ts`,
> `apps/web/src/components/editor-store.ts`, untouched) kept compiling unchanged.
> `seed-workflow.ts`'s `SeedTask` gained an optional `kind` (default `browser`) so tests can
> seed asset tasks through the same `publishVersion` path every other seeded task goes
> through, rather than adding a second way to write a graph.
>
> No `apps/web/src/server` changes: `publishVersion`'s `AppError` (code `graph_invalid`)
> already flows through `trpc.ts`'s `errorFormatter` to `error.data.appError` — confirmed by
> reading the S2d-era formatter, not assumed. There is also no schedule-mutation procedure
> separate from `publishVersion` to guard — schedules are only ever written by publishing a
> graph.
>
> Deviation: `updateTask` (in-place prompt/mode/limits edit) is *not* given a typed-error
> guard against `mode=compiled` on an asset task. It is a raw `UPDATE`, same shape as the
> "direct SQL update" the spec's own test targets — the DB check is already its backstop, not
> a gap. Adding a duplicate check there would be restating deliverable 3's boundary in a
> second place the spec doesn't name; flagging it here in case a later subphase wants
> `updateTask` to reject earlier with a nicer message.
>
> Deviation: the DB constraints could not be probed with `.rejects.toThrow(/pattern/)`
> directly — drizzle-orm wraps the driver error (`"Failed query: ..."`) and puts Postgres's
> own message on `.cause`, which `toThrow` never inspects. `kind-constraints.test.ts` adds a
> small `causeMessage()` helper rather than asserting on the wrapper text.
>
> Migration number: **0010**. Tests: `tests/system/kind-constraints.test.ts` (7 tests) covers
> every bullet in the spec's deliverable 5, including the seeded-default-kind assertion the
> Verification section asks for — the template-clone test-DB helper always runs the full
> migration chain against an empty database, so there is no way to construct a genuinely
> pre-S5a row in this suite; the assertion instead confirms a task seeded without an explicit
> `kind` reads back `'browser'`, which is what the column's `DEFAULT` is actually responsible
> for. `pnpm install && pnpm build && pnpm lint && pnpm test` green twice: **174 passed, 1
> skipped (keyless live-eval), 175 total, 44 files** both runs (up from 168/43 by exactly this
> subphase's one new file). `apps/web`'s `next build` green (0 errors, 0 warnings). No
> flakiness across two full runs. No leaked Chrome processes or test databases after the
> suite (`pgrep` for a debugging-port Chrome and a `pg_database` count for
> `tabductor_test_%` both came back clean).
