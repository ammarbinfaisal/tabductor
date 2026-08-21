# Running it

Everything — Postgres, migrations, the engine, the control plane — comes from the root
`docker-compose.yml`.

```sh
docker compose up -d          # the whole app
open http://localhost:3000    # workflows, graph editor, runs, events
```

That is the only command needed from a cold checkout. The first run builds the image
(~2 min); after that a cold start is a few seconds.

| Service | What it is | Notes |
|---|---|---|
| `postgres` | Postgres 16 | `127.0.0.1:5434` for the test suite (see `BIND_ADDR` below) |
| `minio` | MinIO (S3 API) blob store | `127.0.0.1:9002` for the test suite |
| `migrate` | one-shot drizzle migrator | runs to completion; `engine` and `web` wait on its exit 0 |
| `engine` | outbox dispatcher, run loop, cron scheduler, timeout watchdog, crash recovery | no ports |
| `web` | Next.js + tRPC control plane | `127.0.0.1:3000` |
| `otel-lgtm` | Grafana LGTM | `--profile telemetry` only |

### Exposing it beyond this machine

Every published port binds `127.0.0.1` by default. `BIND_ADDR` moves them:

```sh
BIND_ADDR=0.0.0.0 docker compose up -d
```

Do that deliberately. The bundled credentials are `tabductor`/`tabductor` on both Postgres and
MinIO, so anything that can route to the host can read and write the database and the blobs.
There is no authentication in front of the control plane either. On anything but a trusted
network, put a reverse proxy with real auth in front and leave these on loopback.

```sh
docker compose logs -f engine        # what the run loop is doing
docker compose up -d --build         # after changing code
docker compose down                  # stop; add -v to discard the data volumes
docker compose up -d postgres minio  # just the datastores — all the test suite needs
```

## Why it is shaped this way

**One image, three commands.** `engine` and `web` are the same workspace under different
entry points; two images would let the packages the engine executes drift from the packages
the control plane reads through between rebuilds.

**Migrations are their own service, not something the app does on boot.** `engine` and `web`
start together, and two processes racing the same migration is how a schema ends up half
applied. Both `depends_on` `migrate` completing successfully.

**The engine runs as `node --import tsx`, not `pnpm start`.** SIGTERM has to reach the
engine's own handler so in-flight runs get their grace period; every wrapper process between
PID 1 and the app is somewhere that signal can be dropped, and one of them was dropping it.
A `docker compose stop engine` now logs `shutting down` and exits 0.

**A started container never needs the network.** Corepack's pnpm cache is baked into the
image rather than downloaded on first use, so the app boots behind a firewall.

**The secrets KEK lives on a volume.** `fileKeyWrapper` mints a key-encryption key on first
use if the file is absent. Left on the container's writable layer, every `--build` or container
recreation would mint a *new* one and orphan every already-wrapped `secrets` row — permanently,
and with no error until a `fill` fails. The `kek` volume is mounted at `/app/data`, which is
where `SECRETS_KEK_FILE_PATH` defaults. Back it up like the database; losing it loses every
stored secret.

**Both app processes get the model keys.** `web` needs one to compile an event description into
a packet schema at publish; `engine` needs one to run the `ai`-mode executors. Neither requires
it: with no key, publishing still carries unchanged schemas forward by hash, and the engine logs
which executors it withheld at boot.

**Chrome is not a service.** The testkit launches local Chrome per test on a throwaway
`--user-data-dir`, and that locally-launched browser *is* the BYO-CDP simulator — connected
to exactly the way production connects to a user's endpoint. See the environment deviations
in `docs/subphases/ROADMAP.md`. Fixture sites are served in-process for the same reason.

## When `migrate` fails with "migration drift"

The migrator checks, after applying, that every migration this checkout ships is accounted for
in the database's ledger — and exits non-zero when it is not, which holds `engine` and `web`
back rather than letting them boot against a schema missing tables.

It fires because drizzle tracks a single high-water mark rather than a per-migration ledger: it
applies a migration only when the newest `created_at` in `drizzle.__drizzle_migrations` is older
than that migration's journal `when`. A ledger row left by another checkout — a parallel
worktree, a branch carrying its own `0015` — pushes that mark past ours, and every migration at
or below it is skipped in silence. Without the check the migrator would exit 0 and the app would
start against a half-built schema.

The error names every unaccounted-for migration, its computed sha256, and the two remedies: for
a development volume, `docker compose down -v && docker compose up -d`; for an instance whose
data matters, apply each named file by hand and insert its ledger row.

## Local development without containers

```sh
docker compose up -d postgres minio     # the two things that must be containers
pnpm install
pnpm -F @tabductor/db migrate
pnpm dev:engine                         # tsx watch on the engine composition root
pnpm dev:web                            # next dev on :3000
```

Defaults are compiled in, so a clean checkout needs no environment at all:

| Setting | Default | Where |
|---|---|---|
| host / port | `localhost:5434` | `apps/testkit/src/db.ts` |
| user / password | `tabductor` / `tabductor` | `apps/testkit/src/db.ts` |
| `DATABASE_URL` | `postgres://tabductor:tabductor@localhost:5434/tabductor` | `packages/core/src/config.ts`, `packages/db/drizzle.config.ts` |
| `BLOB_ENDPOINT` | `http://localhost:9002` (`http://minio:9000` in the containers) | `packages/core/src/config.ts` |
| `BLOB_ACCESS_KEY` / `BLOB_SECRET_KEY` | `tabductor` / `tabductor` | `packages/core/src/config.ts` |
| `BLOB_BUCKET` | `tabductor-blobs` | `packages/core/src/config.ts` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | unset — see below | `packages/core/src/config.ts`, passed to `web` only |
| `SCHEMA_MODEL` | provider default (`claude-opus-5` / `gpt-5.2`) | `packages/engine/src/schema-generator-ai.ts` |

**Why MinIO rather than the filesystem.** Blobs are content-addressed (`sha256:<digest>` is
both the key and the integrity check), so the store needs nothing beyond put/get — no listing,
no delete. Speaking the S3 API for that little surface means a real S3 or R2 bucket in
production is an endpoint swap, not a rewrite, and gets presigned URLs for free when a later
phase wants them. The bucket is created lazily, on first `put` — no one-shot bootstrap service.

Override with the standard `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD` (testkit) or
`DATABASE_URL` (app + drizzle-kit) to point at any other instance.

A model API key is the one setting a full deployment eventually wants. Publishing a workflow
version compiles each event's description into a packet schema
(`docs/event-centric-model.md` §3), and the `web` service is the only composition root that
does it — the engine executes published versions and never calls a model, so it does not get
a key. Either provider works; Anthropic wins when both are set. Put it in a `.env` beside
`docker-compose.yml` and compose picks it up:

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env && docker compose up -d web
# or
echo 'OPENAI_API_KEY=sk-...' >> .env && docker compose up -d web
# pin a model id, whichever provider:
echo 'SCHEMA_MODEL=gpt-5.4' >> .env
```

Unset is a working mode rather than a broken one: unchanged events carry their schema forward
by prompt hash, so a publish that adds no event and edits no prompt still succeeds. A publish
that needs a *new* schema fails atomically, naming the events it could not compile and leaving
the previous version serving.

The credentials are trivial on purpose — the container holds nothing but throwaway test
databases and binds to loopback. Do not reuse it for anything else.

```sh
# health check
PGPASSWORD=tabductor psql -h localhost -p 5434 -U tabductor -d postgres -c 'select version()'
```

The system suite clones a template database per test, so it needs an instance it can
`CREATE DATABASE` against freely. It gets its own rather than borrowing a system one: ports
and role lists on a dev box belong to whoever claimed them first, and the suite should not
lose that race. If the suite fails at SCRAM authentication before any test logic runs, that
is this container being down or a stale `PG*` variable in the shell — not a regression.
Likewise, an `ECONNREFUSED` at `localhost:9002` before any blob-store assertion runs is the
`minio` container being down, not a regression.

## Grafana LGTM (telemetry profile)

Loki, Tempo, Mimir and Grafana in one container, for platform observability
(`docs/techical_plan.md` §17.2). Grafana is on <http://localhost:3001> — 3001 rather than
3000 so the web app keeps its port.

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318 docker compose --profile telemetry up -d
```

Telemetry is **no-op when that variable is unset** (§17.2 rule 2), which is the CI and
docker-less-dev mode, so this profile is never required to run tests.
