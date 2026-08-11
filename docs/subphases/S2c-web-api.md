# S2c — Next.js + tRPC control-plane API

> **Historical build order, superseded in part by EC1 (migration `0007`).** The `edges` table
> this file describes no longer exists: events are workflow-version entities keyed
> `(version, type)`, tasks declare `emits`/`consumes`, and dispatch routes by type. Current
> model: `docs/event-centric-model.md`.

You are implementing subphase S2c. Read, in order:
1. This file (authoritative).
2. `docs/subphases/ROADMAP.md` — stack decisions (Next.js/tRPC/zod/Drizzle, React hook policy).
3. `docs/techical_plan.md` — §3 (control plane's place in the architecture), §4, §5.
4. Existing code: `packages/db` (Drizzle schema — the source of truth for shapes),
   `packages/engine` (seed/dispatch APIs), `packages/bus`.

## Scope
The control-plane API layer as a Next.js app. UI beyond a minimal smoke page is **U0**
(the first UI-track slice, `docs/impl-phases.md`, which follows immediately after this
subphase) — do NOT build the React Flow editor or run inspector now. The deliverable is
the typed API that U0 and the system tests share.

## Deliverables

1. **`apps/web`** — Next.js (App Router) + tRPC v11 + zod:
   - tRPC routers (composed in `appRouter`), every procedure with zod `.input()`:
     - `workflow`: create, list, get (with tasks/edges of current version),
       `publishVersion` (new graph_json → new `workflow_versions` row + task/edge/event_def
       rows in one transaction).
     - `task`: update prompt/limits/mode; get.
     - `run`: list by task/workflow with status filter + cursor pagination; get (with trigger
       event); cancel (status → `cancelled` via the engine's transition helper, only from
       `queued|running`).
     - `event`: list by workflow with type filter + pagination; get with lineage chain
       (reuse bus `chainDepth`/parents — no reimplementation).
   - Context: one server-side composition (`createDb` once per process, injected into ctx).
     No engine execution inside Next.js — the web app reads/writes definitions and run rows;
     the engine process owns execution (they share only Postgres).
   - Input schemas: packet/graph JSON validated structurally (zod) at the API boundary;
     user-authored packet JSON Schemas additionally compile-checked with ajv at
     `publishVersion` time (a schema that doesn't compile is a 400, not a runtime surprise).
   - Export the `AppRouter` type from a path importable by tests (and later the UI).

2. **React hook policy plumbing** (for the smoke page and all future UI):
   - `apps/web/src/lib/use-mount-hook.ts`: `useMountHook(fn: () => void | (() => void))` —
     the ONLY React hook allowed in this codebase (wraps `useEffect(fn, [])`).
   - ESLint rule (flat config, `no-restricted-imports`/`no-restricted-syntax`) forbidding
     `useState|useEffect|useMemo|useCallback|useReducer|useRef|use[A-Z]\w*` in `apps/web`
     except `useMountHook` and its own definition file. Wire `pnpm --filter web lint`.
   - One smoke page (`/status`): server component listing workflows + run counts via direct
     router call (no client fetch needed). If you add any client component, it must comply
     with the policy.

3. **System tests** (`tests/system/`, content-named e.g. `web-api.test.ts`):
   - Spin the tRPC router directly via `createCaller` against a migrated test DB (no HTTP
     server needed for router logic; add ONE HTTP-level test via `next start` or a route
     handler invocation if cheap — otherwise createCaller coverage is acceptable, note it).
   - Cover: workflow create → publishVersion → get returns graph; invalid packet JSON Schema
     rejected at publish; run list pagination + status filter; cancel transitions only legal
     states (cancelling a `succeeded` run → typed error); event lineage endpoint returns the
     causation chain; every procedure rejects malformed input (zod errors surface as
     BAD_REQUEST).

## Style constraints (binding)
- The web app composes existing packages; business logic lives in packages, not routers.
  A router procedure longer than ~30 lines is a smell — extract to the owning package.
- No REST duplication, no API versioning, no auth in this subphase (single-user local).
- New deps: `next`, `react`, `react-dom`, `@trpc/server`, `@trpc/client`, `superjson`
  (if needed for Date/JSON serialization), eslint + minimal config. Justify anything else.

## Verification
```
pnpm install && pnpm build && pnpm test && pnpm --filter web lint
```
All prior tests stay green. `pnpm --filter web dev` must boot and `/status` render.

## Report back
What you built, deviations + why, commands + outcomes, flakiness. Do NOT git commit.
