# Backing services

Everything the app talks to runs from the root `docker-compose.yml`.

```sh
docker compose up -d                        # Postgres — all you need for the suite
docker compose --profile telemetry up -d    # + Grafana LGTM, when exporting OTLP
docker compose down                         # stop; add -v to discard the data volumes
```

## Postgres

The system suite clones a template database per test, so it needs an instance it can
`CREATE DATABASE` against freely. It gets its own rather than borrowing a system one:
ports and role lists on a dev box belong to whoever claimed them first, and the suite
should not lose that race.

Defaults are compiled into the code, so a clean checkout needs no environment at all:

| Setting | Default | Where |
|---|---|---|
| host / port | `localhost:5434` | `apps/testkit/src/db.ts` |
| user / password | `tabductor` / `tabductor` | `apps/testkit/src/db.ts` |
| `DATABASE_URL` | `postgres://tabductor:tabductor@localhost:5434/tabductor` | `packages/core/src/config.ts`, `packages/db/drizzle.config.ts` |

Override with the standard `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD` (testkit) or
`DATABASE_URL` (app + drizzle-kit) to point at any other instance.

The credentials are trivial on purpose — the container holds nothing but throwaway test
databases and binds to loopback. Do not reuse it for anything else.

```sh
# health check
PGPASSWORD=tabductor psql -h localhost -p 5434 -U tabductor -d postgres -c 'select version()'
```

If the suite fails at SCRAM authentication before any test logic runs, that is this
container being down or a stale `PG*` variable in the shell — not a regression.

## Grafana LGTM (telemetry profile)

Loki, Tempo, Mimir and Grafana in one container, for platform observability
(`docs/techical_plan.md` §17.2). Grafana is on <http://localhost:3001> — 3001 rather than
3000 so `next dev` keeps its port. Point the app at it with:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Telemetry is **no-op when that variable is unset** (§17.2 rule 2), which is the CI and
docker-less-dev mode, so this profile is never required to run tests.

## What is deliberately not containerised

- **Chrome.** The testkit launches local Chrome headless per test on a throwaway
  `--user-data-dir`; that locally-launched browser *is* the BYO-CDP simulator, connected to
  exactly the way production connects to a user's endpoint. See the environment deviations
  in `docs/subphases/ROADMAP.md`.
- **Fixture sites.** Served in-process by the testkit — no network hop, no orchestration.
- **The app itself.** There is no composition root to image yet (`apps/engine` is unbuilt).
  App images land with the process they package.
