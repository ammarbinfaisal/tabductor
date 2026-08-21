# tabductor

An agentic browsing platform. You describe a workflow in plain language; it runs as a graph of
browser, asset and decision nodes, triggered by cron or by each other's events, driving a
browser **you already own** over CDP.

Self-hosted and open source (AGPL-3.0). Nothing phones home; the only outbound calls are the
ones your workflows make and the LLM provider you configure.

```sh
git clone <this repo> && cd tabductor
docker compose up -d
open http://localhost:3000
```

That is the whole setup — Postgres, MinIO, migrations, the engine and the control plane. Add an
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to `.env` to enable the AI-mode nodes; without one the
app runs fine and simply withholds those executors, saying so at boot.

Ports bind to loopback by default. Set `BIND_ADDR=0.0.0.0` to expose them on a LAN — read the
note in `docker-compose.yml` first, because the bundled datastore credentials are trivial.

## The idea

Most browser automation breaks because it is written as a script against a page that changes.
Here, a node starts as an **LLM agent** driving a real browser and describing what it did. Once
two runs agree on the same path, the platform compiles that path into a plain script and runs
it with no model calls at all. When the site changes and the script's guards fail, it **deopts**
back to the agent mid-run, finishes the job, and recompiles. You pay for a model while the shape
of a task is uncertain, and stop paying once it is not.

Events are the wiring. A node declares the event types it emits and consumes; there are no
edges to draw, and the topology falls out of those declarations. Each event type carries a
plain-language description that is compiled into a packet schema at publish time, so every
packet crossing the system is validated against a real JSON Schema.

## Node kinds

| Kind | Gets | For |
|---|---|---|
| `browser` | `page.*`, `network.*`, `secrets.fill`, `emit` | driving a page |
| `asset` | `mcp.*`, `assets.*`, `store.query/insert/upsert`, `emit` | producing deliverables — files, decks, spreadsheets |
| `decision` | `store.query`, `emit` | choosing what to do next, and nothing else |

The registries are **disjoint by design**, enforced by tests rather than by convention: a
browser task cannot reach an MCP server, and a decision task cannot touch a page. That boundary
is the reason an untrusted page's text cannot reach a tool that would act on it.

## Where things are

| Path | What |
|---|---|
| `packages/core` | ids, errors, config, logger |
| `packages/db` | Drizzle schema + migrations |
| `packages/bus` | transactional outbox, dispatcher, dedupe, lineage |
| `packages/engine` | run state machine, graph dispatch, scheduler, retries, the graph document |
| `packages/browser` | CDP driver, navigation guard, network observer, trace recorder |
| `packages/agent` | the agent loop, perception, tool registries per node kind |
| `packages/assets` | content-addressed asset store, write grants |
| `packages/mcp` | per-run MCP client (asset nodes only) |
| `packages/store` | the per-workflow SQL store, fenced reads, role pair |
| `packages/secrets` | envelope encryption; fills a form without becoming a string |
| `packages/policy` | `PolicyGate` interface (real evaluator lands in Phase 7) |
| `packages/telemetry` | OTel + pino — inert unless an OTLP endpoint is set |
| `apps/engine` | composition root: the process that executes runs |
| `apps/web` | Next.js + tRPC control plane and UI |
| `apps/renderer` | sandboxed LaTeX/PDF renderer |
| `apps/testkit` | fixture sites, Chrome launcher, test-database helper |
| `tests/system` | the tests that matter — real Postgres, real bus, real engine |

## What works today

Author a graph as events and prompts, publish it, and watch runs flow — with retries, timeouts,
loop budgets, dedupe and crash recovery underneath. Browser nodes drive real Chrome through an
agent loop that sees a structured perception of the page and emits validated packets. Asset
nodes call MCP servers, render LaTeX in a sandboxed container, and write versioned assets.
Decision nodes read the workflow's own SQL store and pick the next move. A run inspector shows
the trace — navigations, actions, network reads, policy denials, model calls with token counts.
Share a workflow with an unguessable link and anyone can watch it live, seeing packets only for
the event types you marked shared.

Asset nodes can also run an authored Python program (`mode=python`) against a pinned
scientific stack, producing spreadsheets and other computed deliverables.

Still ahead: the compiled-script runtime and its deopt loop, the real policy evaluator, and
one-prompt-to-a-graph compilation. See
[`docs/subphases/ROADMAP.md`](docs/subphases/ROADMAP.md) for status.

## Design docs

- [`docs/techical_plan.md`](docs/techical_plan.md) — the design
- [`docs/impl-phases.md`](docs/impl-phases.md) — the incremental build order
- [`docs/subphases/ROADMAP.md`](docs/subphases/ROADMAP.md) — subphase status, one spec per subphase

Companion designs, each extending the main one:
[`event-centric-model.md`](docs/event-centric-model.md) (events as entities, prompts as the only
authoring surface), [`graph-compilation-llm.md`](docs/graph-compilation-llm.md) (the decision
node, the per-workflow data store, one prompt to a graph),
[`sharing.md`](docs/sharing.md) (watch a workflow run, with visibility opt-in per event type),
[`python-compute.md`](docs/python-compute.md) (`mode=python` — an authored Python program, for
the numbers).

## Working on it

```sh
docker compose up -d postgres minio
pnpm install
pnpm build      # typecheck the workspace + the Next app
pnpm test       # unit + system suites
pnpm lint
```

The system suite launches your local Chrome headless on a throwaway profile — that browser *is*
the BYO-CDP simulator, connected exactly the way production connects to a user's endpoint. No
test touches the public internet or a live model; LLM behaviour is driven from recorded
transcripts. See [`infra/README.md`](infra/README.md) for what each service is and how to run
without containers.

## License

AGPL-3.0. If you run a modified version as a network service, its users are entitled to your
changes — see [`LICENSE`](LICENSE).
