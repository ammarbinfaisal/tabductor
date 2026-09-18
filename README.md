# tabductor

Tabductor turns natural-language intent into durable browser workflows. The authored product
surface is a workflow and its behavior; internal graphs are compiled, versioned, observed, and
eventually optimized from operational evidence.

There are two internal execution kinds:

- **Browser** navigates and acts through an attached CDP browser, then emits validated events.
- **Decision** performs semantic work and can query, insert, and upsert the workflow store.

There is no asset node, file-production runtime, document renderer, or Python runner. `stub`
exists only for deterministic automated tests. Browser tasks may be promoted to guarded static
scripts after successful execution; decision tasks remain AI-driven.

## Run locally

Copy `.env.example` to `.env` if it does not exist, then set `CLERK_SECRET_KEY` and
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from the same Clerk development instance.

```sh
docker compose up -d --build
open http://localhost:3000
```

Compose starts Postgres, MinIO, one-shot migrations, the engine, and the Next.js control plane.
Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to compile new workflow intent and run AI tasks.
MinIO stores browser trace blobs.

After changing Clerk keys in `.env`, run `docker compose up -d --no-deps web` to
recreate the web container with the new values. A container restart alone does not reload
Compose environment variables.

Browser navigation defaults to `POLICY_NAVIGATION_MODE=permissive`: pages, redirects,
popups, and embedded frames can load without per-host task grants, including identity
providers on separate domains. Account deny and approval rules still apply. Set
`POLICY_NAVIGATION_MODE=grant_required` to require explicit navigation grants again.
Network headers, secret access, and store writes retain their explicit permission checks.

## MCP control plane

The Streamable HTTP endpoint is `POST /api/mcp`. It exposes exactly four high-level tools:

- `workflow_publish`
- `workflow_update`
- `workflow_trigger`
- `workflow_schedule`

These tools accept workflow intent and workflow ids, not internal task ids or node topology.
They call the same compiler, publication, trigger, and scheduling code as the web control plane.

## Architecture

| Package/app | Responsibility |
| --- | --- |
| `apps/engine` | dispatch, scheduling, browser/decision executors, trace compile jobs |
| `apps/web` | workflow UI, tRPC API, workflow MCP endpoint |
| `packages/engine` | graph/version model, routing, publication, graph compiler gates |
| `packages/agent` | browser and decision AI loops/tool registries |
| `packages/browser` | CDP driver, pool, perception, trace blobs |
| `packages/store` | workflow-scoped schemas, migration, fenced query/write tools |
| `packages/compiler` | post-execution browser trace compiler |
| `packages/mcp` | workflow-level MCP protocol server |
| `packages/policy` | grants, redaction, approvals, baselines |

The store schema and graph are one publication concern: an accepted candidate may rearrange
browser/decision work and migrate tables in the same version publish. Decision writes are
schema-validated and commit atomically with an emitted event or successful completion.

## Development

```sh
pnpm install
pnpm build
pnpm lint
pnpm test
```

See [the technical plan](docs/techical_plan.md), [implementation phases](docs/impl-phases.md),
[graph compilation](docs/graph-compilation-llm.md), and
[post-execution trace compilation](docs/trace-compilation.md).
