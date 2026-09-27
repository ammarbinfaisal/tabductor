# Repository Guidelines

## Project Structure & Module Organization

Tabductor turns natural-language intent into durable browser workflows. This pnpm workspace separates runnable services in `apps/` from shared modules in `packages/`.

- `apps/web`: Next.js UI, tRPC API, and workflow MCP endpoint.
- `apps/engine`: dispatch, scheduling, and workflow execution; `apps/fleet`, `apps/gateway`, and `apps/browser-worker` support managed browsers.
- `packages/`: agent loops, graph engine, browser integration, compiler, policy, secrets, store, and telemetry. Database migrations live in `packages/db/migrations/`.
- Unit tests sit beside source; system tests and fixtures live in `tests/system/`. `apps/testkit/` provides test infrastructure and fixture sites.
- `docs/` contains design notes; `infra/` and `scripts/` contain deployment and development tooling.

## Build, Test, and Development Commands

Use pnpm 9.12.3, as pinned in `package.json`.

- `pnpm install`: install workspace dependencies.
- `pnpm local:up` / `pnpm local:down`: start or stop the managed Docker stack.
- `pnpm dev:web` / `pnpm dev:engine`: run the web app or engine in development mode with supporting services configured.
- `pnpm build`: type-check the workspace and web app.
- `pnpm build:web`: create the production Next.js build.
- `pnpm lint`: run ESLint, secret-leak checks, and web linting.
- `pnpm test`: run unit and system tests; `pnpm test:system` runs only system tests.
- `pnpm exec vitest run --project unit`: run unit tests independently.

## Coding Style & Naming Conventions

Follow existing TypeScript style: two-space indentation, double quotes, semicolons, and strict typing. Use kebab-case filenames, camelCase functions and variables, and PascalCase types and React components. Shared packages use ESM/NodeNext; preserve existing `.js` suffixes in relative imports. Use the injected logger instead of `console` in runtime code. ESLint enforces logging rules and separate web policies.

## Testing Guidelines

Use Vitest and name tests `*.test.ts`. Add regression coverage for changed behavior and reuse testkit helpers. Database-backed tests require PostgreSQL; testkit defaults to port 5434. No numeric coverage threshold is configured. Keep default tests deterministic; provider-backed evaluations run separately with `pnpm test:live-eval` and require credentials.

## Commit & Pull Request Guidelines

Follow history's Conventional Commit prefixes, such as `feat:`, `fix:`, and `test:`, with concise imperative subjects. PRs should explain behavior changes, link relevant issues, list validation performed, and include screenshots for UI changes. Call out migrations and configuration changes.

## Configuration & Secrets

Create `.env` from `.env.example` only if absent. Configure matching Clerk development keys as described in `README.md`. Keep credentials, browser session state, and local environment files out of commits.
