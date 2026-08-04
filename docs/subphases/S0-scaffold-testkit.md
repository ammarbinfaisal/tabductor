# S0 — Monorepo scaffold + test infrastructure

You are implementing the first subphase of the agentic browsing platform described in
`docs/techical_plan.md` (architecture) and `docs/impl-phases.md` (phased plan). Read both
before writing code — especially impl-phases "Repository & runtime layout" and
"Test infrastructure". This file is the authoritative task spec where it differs.

## Environment facts (this machine, no Docker)
- Node v24, pnpm 9.12 via corepack. Repo root: `/Users/ammar/Documents/codes/tabductor`.
- PostgreSQL 15 running at `localhost:5432`, superuser role `ammar`, no password (trust).
  Binaries in `/opt/homebrew/opt/postgresql@15/bin`.
- Google Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
  No Docker: tests use local Postgres + locally launched headless Chrome (that IS the
  BYO-CDP simulator; production connects to user endpoints the same way).

## Deliverables

1. **Workspace scaffold**
   - `pnpm-workspace.yaml` covering `packages/*`, `apps/*`.
   - Root `package.json` (private, scripts: `build`, `test`, `test:system`), root
     `tsconfig.base.json` (strict, ES2022, NodeNext modules, composite refs optional —
     keep it simple; per-package tsconfig extends base).
   - Vitest at root with two projects/configs: unit-ish tests (`*.test.ts` inside packages)
     and system tests (`tests/system/**/*.test.ts`).
   - Create package stubs ONLY for what S0 fills: `packages/core`, `apps/testkit`.
     Do NOT pre-create empty packages for future phases — later subphases add their own.

2. **`packages/core`** — tiny, no speculation:
   - `ids.ts`: `newId(prefix)` → `prefix_<uuidv7-or-v4>`.
   - `errors.ts`: one `AppError extends Error` with `code: string` + `cause` support. No error class zoo.
   - `config.ts`: zod-validated env loader (`DATABASE_URL`, `BLOB_DIR`, `HARNESS_NAV_ALLOWLIST`,
     optional `ANTHROPIC_API_KEY`) with defaults suitable for local dev.
   - `logger.ts`: minimal leveled logger over console (JSON lines). No pino dependency.

3. **`apps/testkit`** — the permanent test backbone:
   - **Fixture sites** (`apps/testkit/sites/`): one small Node HTTP server (no Express;
     `node:http` is fine) serving four apps by path prefix:
     - `/fake-tweets`: timeline page, tweets rendered as `<article data-testid="tweet">` with
       `[data-testid="tweetText"]`, a `/status/<id>` link, and `<time datetime>`; page fetches
       tweets via an XHR (`GET /fake-tweets/api/timeline`) so network-observation tests have
       a real XHR; `POST /fake-tweets/admin/add-tweet` injects a new tweet (in-memory).
     - `/fake-gram`: login form (username/password POST) + a "create post" form (caption +
       image URL); records submissions in memory; `GET /fake-gram/admin/submissions` returns them.
     - `/mutator`: same timeline as fake-tweets but `?layout=v2` switches all selectors/classes
       (different data-testids, different DOM nesting) — used later to force deopts.
     - `/slowpoke`: page + API with configurable latency via `?delay_ms=`.
     - Server export: `startFixtures(port?) → { port, url, close() }` for in-test use, plus a
       CLI entry (`pnpm --filter testkit fixtures`).
   - **CDP launcher** (`apps/testkit/src/chrome.ts`): `launchChrome() → { wsUrl, close() }` —
     spawns the local Chrome binary headless (`--headless=new`) with `--remote-debugging-port=0`
     on a fresh temp `--user-data-dir`, parses the DevTools WebSocket URL (from
     `http://127.0.0.1:<port>/json/version`), and kills + cleans up on close. Must be robust to
     slow cold starts (poll with timeout).
   - **Test DB helper** (`apps/testkit/src/db.ts`): `createTestDb() → { url, drop() }` —
     creates a uniquely named database on local PG (template clone from a prepared template DB
     when a `prepareTemplate(sqlApplier)` has run; plain `CREATE DATABASE` otherwise). Parallel-safe.
   - Testkit exports these from the package root (`@tabductor/testkit`).

4. **Smoke tests** proving the kit works (these are the S0 acceptance tests):
   - `tests/system/fixtures.test.ts`: start fixtures; fetch fake-tweets page + timeline API;
     add a tweet via admin; see it in the API; fake-gram records a submission; mutator v1 vs v2
     HTML differs; slowpoke delays ≥ requested.
   - `tests/system/chrome-cdp.test.ts`: launch Chrome, raw CDP over WebSocket (use the `ws` pkg or
     playwright-core's CDP — smallest option wins), `Browser.getVersion` returns, navigate a page
     to a fixture URL and read its title via CDP `Runtime.evaluate`. Close cleanly.
   - `tests/system/test-db.test.ts`: two `createTestDb()` in parallel → distinct DBs, both usable
     (create table, insert, select), both drop cleanly.

   Naming rule (project-wide): file names describe content, never the subphase that created
   them — no `s0-`/`s1-` prefixes anywhere.

## Style constraints (binding)
- Composition over abstraction. No interfaces/base classes beyond what's listed. No DI framework.
- Prefer less code. A helper used once gets inlined. No barrel files except each package's index.
- TypeScript strict everywhere. ESM (`"type": "module"`).
- Dependencies: keep to zod, vitest, ws (if needed), pg (for db helper), typescript, tsx. Justify
  anything else in your final report.

## Verification (run these; all must pass)
```
pnpm install
pnpm -r build   (or root tsc -b; your choice, but a single command must typecheck everything)
pnpm test       (runs the three system smoke tests + any unit tests)
```

## Report back
Final message: what you built, deviations from this spec and why, exact commands you ran and
their outcomes, and anything flaky you noticed. Do NOT git commit — the reviewer commits.
