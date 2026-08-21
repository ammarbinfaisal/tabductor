# Test / dev Postgres

The system suite needs a Postgres it can `CREATE DATABASE` against freely (it clones a
template database per test). It runs in a container owned by this project rather than
against a system instance — a dev machine's port 5432 and its role list belong to whichever
project claimed them first, and the suite should not lose that race.

```sh
docker run -d --name tabductor-pg \
  -p 127.0.0.1:5434:5432 \
  -e POSTGRES_USER=tabductor \
  -e POSTGRES_PASSWORD=tabductor \
  -e POSTGRES_DB=postgres \
  --restart unless-stopped \
  postgres:16-alpine
```

That matches the defaults compiled into the code, so a clean checkout needs no environment
at all:

| Setting | Default | Where |
|---|---|---|
| host / port | `localhost:5434` | `apps/testkit/src/db.ts` |
| user / password | `tabductor` / `tabductor` | `apps/testkit/src/db.ts` |
| `DATABASE_URL` | `postgres://tabductor:tabductor@localhost:5434/tabductor` | `packages/core/src/config.ts`, `packages/db/drizzle.config.ts` |

Override with the standard `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD` (testkit) or
`DATABASE_URL` (app + drizzle-kit) to point at any other instance.

The credentials are deliberately trivial: this container holds nothing but throwaway test
databases and is published on loopback only. Do not reuse it for anything else.

## Health check

```sh
PGPASSWORD=tabductor psql -h localhost -p 5434 -U tabductor -d postgres -c 'select version()'
```

If the suite fails at SCRAM authentication before any test logic runs, that is this
container being down or a stale `PG*` variable in the shell — not a regression.

## Cleanup

```sh
docker rm -f tabductor-pg    # drops every test database with it
```
