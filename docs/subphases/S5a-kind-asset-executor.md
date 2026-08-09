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
