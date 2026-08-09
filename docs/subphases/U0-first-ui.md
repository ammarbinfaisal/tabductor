# U0 — First UI: graph editor, runs, events (over the S2c API)

You are implementing UI-track slice U0. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — "The UI track" section (U0 row + the two standing rules).
3. `docs/subphases/S2c-web-api.md` — the API you consume; `docs/subphases/ROADMAP.md` —
   stack rules, especially the **React hook policy**.
4. Existing code: `apps/web` (routers, `AppRouter` type, `useMountHook`, ESLint hook rule),
   `packages/engine` (StubExecutor's scripted-behavior JSON shape, seed-workflow helper),
   `packages/db` (schema — source of truth for shapes).

## Scope
Everything a user needs to author a graph, trigger it, and watch runs/events flow — with
StubExecutor, before any browser exists. NOT in scope: run inspector (U1), packet-schema
authoring (U2), grants/approvals (U5), any asset/secret/MCP surface (U3). **No UI tests**
(doctrine): if a page needs data no endpoint serves, that is an S2c-family backend change
with a system test — never logic in the web app.

## Deliverables

1. **Sanctioned client-state pattern** (`apps/web/src/lib/store.ts`) — build this first,
   everything client-side uses it:
   - One vanilla store per page concern via `zustand/vanilla` (`createStore`) — plain
     objects + action functions that call the vanilla tRPC client. NO React Query, NO
     useState anywhere (ESLint already enforces).
   - One bridge component: `useStoreBridge(store)` built on `useMountHook` — subscribes on
     mount, forces re-render on store change (a `forceUpdate` via an external tick counter
     is acceptable inside the bridge ONLY; document it as the single exemption).
   - Polling: `useMountHook(() => { const t = setInterval(store.refresh, ms); return () =>
     clearInterval(t) })` — the pattern for runs/events liveness. No websockets in U0.
2. **Workflow list** (`/workflows`) — server component; name, current version, task count,
   last-run status; create button (name only → `workflow.create`).
3. **Graph editor** (`/workflows/[id]`) — React Flow (`@xyflow/react`) in **controlled
   mode**, nodes/edges fed from a vanilla store (bridge above):
   - **Palette registry is data, not code:** `NODE_KINDS: Record<Kind, {label, configPanel,
     schedulable}>` with `browser` and `asset` entries — S5g adds `decision` by adding one
     entry. No `if (kind === ...)` scattered in components.
   - Node config panel: prompt, limits JSON, mode, declared emitted event types.
   - Edge creation binds an event type from the emitter's `event_defs`; the schedule form
     (cron/tz/missed policy/overlap policy/max queue depth) appears only on `schedulable`
     kinds.
   - Save = `workflow.publishVersion`. The API is the validator — render its typed errors
     (schedule→asset binding, bad packet schema) inline at the offending node/edge; do not
     duplicate validation client-side.
   - **Cycle detection**: DFS over the edge list on every change; cycles get a warning
     banner naming the cycle path — warn only, never block (cycles are legal, bounded by
     the loop budget; design doc §18.6).
4. **StubExecutor scripting panel** — per-task editor for the scripted-behavior JSON the
   StubExecutor reads (emit/fail/hang steps), plus a "trigger now" button that injects a
   synthetic trigger event through the API. If S2c lacks a `run.triggerManual`-style
   procedure, add it backend-side with a system test (per the standing rule) — it is the
   one endpoint U0 plausibly finds missing.
5. **Runs table** (`/workflows/[id]/runs`) — status filter + cursor pagination from
   `run.list`, live via the polling pattern; cancel button on `queued|running` rows;
   trigger-event link into the event feed.
6. **Event feed** (`/workflows/[id]/events`) — type filter + pagination; each row links to
   its causation chain (`event.get` lineage) rendered as a breadcrumb, and to the run(s)
   it triggered.

## Style constraints (binding)
- Server components by default; a component goes `"use client"` only if it owns
  interaction. No business logic in components — mutations are store actions calling tRPC;
  anything smarter belongs in a package behind the API.
- React hook policy holds: `useMountHook` only (plus the documented bridge exemption).
- New deps: `@xyflow/react`, `zustand` (vanilla entry). Justify anything else. No CSS
  framework decisions bigger than CSS modules/inline — this is a working surface, not a
  design pass.

## Verification
```
pnpm install && pnpm build && pnpm test && pnpm --filter web lint
```
All prior tests stay green (plus the system test for any endpoint you added).
`pnpm --filter web dev` boots; seed a workflow (engine seed helper), then: author a
two-node graph with an edge and a schedule, save it, trigger it, watch the run appear in
the runs table and its events (with lineage) in the feed — all from the browser.

## Report back
What you built, deviations + why, which endpoints (if any) you added backend-side,
commands + outcomes. Do NOT git commit.
