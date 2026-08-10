# tabductor

An agentic browsing platform: workflows of browser and asset nodes, triggered by cron or by
each other's events, executed against a browser you already own via CDP.

```sh
docker compose up -d
open http://localhost:3000
```

That is the whole setup. It brings up Postgres, applies migrations, and starts both the
engine and the control plane. See [`infra/README.md`](infra/README.md) for what each service
is and how to run without containers.

## Where things are

| Path | What |
|---|---|
| `packages/core` | ids, errors, config, logger |
| `packages/db` | Drizzle schema + migrations |
| `packages/bus` | transactional outbox, dispatcher, dedupe, lineage |
| `packages/engine` | run state machine, graph dispatch, scheduler, retries, the graph document |
| `packages/policy` | `PolicyGate` interface (real evaluator in Phase 7) |
| `packages/telemetry` | OTel + pino, the §17.2 metric registry — inert unless an OTLP endpoint is set |
| `apps/engine` | composition root: the process that executes runs |
| `apps/web` | Next.js + tRPC control plane and UI |
| `apps/testkit` | fixture sites, Chrome launcher, test-database helper |
| `tests/system` | the tests that matter — real Postgres, real bus, real engine |

## What works today

Author a graph in the editor, give a node a StubExecutor script and a cron schedule, publish
it, and watch runs and events flow — with retries, timeouts, loop budgets, dedupe and crash
recovery underneath. The browser runtime, the LLM agent, assets and the policy engine are
the phases after this one.

## Plans

- `docs/techical_plan.md` — the design
- `docs/impl-phases.md` — the incremental build order
- `docs/subphases/ROADMAP.md` — subphase status, one prompt file per subphase

Companion designs, each extending the main one: `docs/graph-compilation-llm.md` (the decision
node, the per-workflow data store, one prompt to a graph), `docs/sharing.md` (a link that lets
anyone watch a workflow run, with visibility opt-in per event type), `docs/python-compute.md`
(`mode=python` — an authored program in a Firecracker microVM, for the numbers).

## Working on it

```sh
docker compose up -d postgres
pnpm install
pnpm build      # typecheck the workspace + the Next app
pnpm test       # unit + system suites
pnpm lint
```

The system tests are the contract: they drive the same tRPC procedures the UI calls and the
same engine the container runs. There are no UI tests, by doctrine.
