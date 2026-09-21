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

Browser agents can extract bounded collections and run isolated JavaScript through the
same validated browser tools, keeping bulk records outside model context. See the
[browser agent runtime](docs/browser-agent-runtime.md) for batch operations, checkpoints,
human takeover, and execution limits.

## Run locally

Copy `.env.example` to `.env` if it does not exist, then set `CLERK_SECRET_KEY` and
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from the same Clerk development instance.

```sh
pnpm local:up
open http://localhost:3000
```

This starts the web app, engine, live-browser gateway, and a local fleet with up to three
active Camoufox browsers and one clean spare. The local fleet uses the Docker socket to
create disposable browser containers; it is unavailable in hosted mode. Local browser time
does not consume Tabductor credits. Model calls still use your selected provider and funding.
The command generates a local worker signing key in `.env` and selects the active Docker
context's socket, including rootless Docker. For the control plane without managed browsers,
use `docker compose up -d --build`.

To shut down the managed local stack, use `pnpm local:down`. It stops the fleet before
removing its disposable browser containers, then removes the Compose services and network.
Database, blob, and encryption-key volumes remain intact. Stop active browser sessions in
Tabductor first to save their latest profile state. Plain `docker compose down` only reads
the base Compose file and can leave the gateway, fleet, and workers using `tabductor_default`.
Mixing a managed startup with a plain `docker compose up` can also report that port 3000
is already allocated: the managed gateway owns that port, while the base configuration
assigns it to the web container. Run `pnpm local:up` to restore the combined configuration.

Open **Profiles** to create a browser profile. Choose **Open browser & sign in**; the session
connects with human control automatically and stays under your control until stopped. Use
the address bar to navigate and log in. Choose **Stop session** and wait for **Profile saved**
before reopening it. Automation sessions open in watch mode, with **Take control** available
when needed. In an automation, follow **Set up browser
profiles and sign in** to select the profile for future sessions.

While controlling a live browser, click its page or address bar and press **Ctrl+V**
(**⌘V** on macOS) to paste text from your computer. Unicode and multiline text are
supported, including when Tabductor is opened over local HTTP. Paste is only forwarded
from the live browser area during active control; watch mode does not transfer it.

Alternatively, [load the Chrome extension](apps/profile-extension/README.md) and import a
selected site's cookies and full local storage with the single-use code from Profiles.
Stop an active session before importing. Some authentication remains bound to the original
device and needs a fresh login. The extension is supplied locally, not through the Web Store.
For an extension on another device, use an [SSH tunnel or reachable HTTPS server address](apps/profile-extension/README.md#connecting-from-another-device).

The **Automation** tab accepts a finished prompt or helps write one through chat. Build the
draft, review its behavior, publish, and run it. **Graph** is a separate local-only tab;
hosted deployments show Automation and Activity.

Compose starts Postgres, MinIO, one-shot migrations, the engine, and the Next.js control plane.
After signing in, open **Models**, save your provider key, and select a model under
**Use your own key**. This account selection enables chat, workflow compilation, and AI tasks.
Server `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` values configure the platform provider;
they do not automatically select a model for a signed-in account. Platform models also
require configured rates and account credits.
MinIO stores browser trace blobs.

After changing keys in `.env`, run `pnpm local:up` to recreate the managed local stack
with the new values. For the control-plane-only setup, use `docker compose up -d --no-deps web engine`.
A container restart alone does not reload Compose environment variables. Web, engine, and
fleet use the same absolute encryption-key path on the persistent `kek` volume so credentials
and imported profile state survive container recreation.

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
