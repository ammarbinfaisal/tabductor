# S5c — MCP client (asset node only) + registry isolation

You are implementing subphase S5c. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 5, S5c section; the "Fake MCP server" test-infrastructure bullet.
3. `docs/techical_plan.md` — §13 (the whole MCP contract: untrusted results, no conferred
   authority, secrets injection), §4 (why the registries are disjoint — a security boundary).
4. `docs/subphases/ROADMAP.md` — node-kinds table; §17.2 telemetry names.

Existing code to reuse (read first): `packages/agent` (tool registry structure from S4b —
MCP tools merge into the ASSET registry only), `packages/secrets` (S5b broker —
`injectIntoMcpArg` is your credential path), `packages/policy` (`checkMcpCall`),
`packages/telemetry`, the S5a `AssetExecutor`. The asset store (`assets.*`) is S5d — NOT
yours; if a fake tool returns bytes, tests hold them in memory.

## Deliverables — new package `packages/mcp`

1. **Migration** (§14): `mcp_servers(id, user_id, label, transport, config_json, secret_name)`.
   `config_json` is zod-validated per transport (`stdio`: command+args+env names;
   `http`: url). **`config_json` never contains a credential value** — a server needing an
   API key names a secret via `secret_name`, resolved at connect/call time through
   `secrets.injectIntoMcpArg` (the broker redeems the handle in-process; the value never
   touches config, context, or trace).

2. **Client** (`client.ts`): `@modelcontextprotocol/sdk`, one client per configured server,
   lazy-connected, `listTools()` cached per process with invalidation on reconnect.
   `callTool(taskCtx, server, tool, args)`:
   - `PolicyGate.checkMcpCall(taskCtx, "mcp.<server>.<tool>")` first (AllowAllGate now; the
     call site is what S7 tightens).
   - Per-run **call budget** (`limits_json.mcp.max_calls`, default 20) and per-call timeout
     (default 60s); budget breach fails the run with a typed error.
   - Trace entries for call args and result (bodies subject to storage opt-out flags, same
     mechanism as S3a).
   - Metrics: `mcp_calls_total{server, outcome}` + `mcp_call_duration_seconds{server, outcome}`.

3. **Registry merge** (in `packages/agent`'s registry structure): each granted MCP tool
   appears in the **asset node's** tool list as `mcp.<server>.<tool>` with the server's
   declared input schema. Two rules from §13 are code, not prompt text:
   - Results are wrapped in delimiters and labelled untrusted data before entering context
     (reuse/extend the demarcation helper the agent loop uses for page content).
   - **A result cannot confer authority**: nothing in this package or the asset registry
     turns a returned URL into navigation (no such tool exists on this node) or a returned
     path into a host filesystem read (paths resolve against the S5d asset namespace only —
     until S5d lands, there is nothing to resolve against; leave the resolution seam as a
     single function with a TODO(S5d)).

4. **Testkit: fake MCP server** (`apps/testkit`): a stdio MCP server exposing `echo`
   (returns its input) and `imageStub` (returns a fixed PNG, base64) — deterministic, no
   external calls. Plus a variant flag to make it require an env-var API key, for the
   credential test.

5. **System tests** (`tests/system/`, content-named, e.g. `mcp-client.test.ts`,
   `mcp-registry-isolation.test.ts`):
   - Asset-node replay transcript calls `mcp.fake.echo` → result appears in agent context
     wrapped in delimiters; trace records call + result; metrics incremented.
   - Call budget: transcript exceeding `max_calls` → run fails typed, trace shows the breach.
   - **Registry isolation (the §4 security boundary — this test is the boundary's proof):**
     build a `kind=browser` task's tool schema and assert NO tool name matches `mcp.*`;
     build a `kind=asset` schema and assert no `page.*`/`network.*` present. A future
     refactor that merges registries must fail here.
   - Credential hygiene: fake server requiring an API key, key stored via S5b → call
     succeeds; grep trace entries and the recorded transcript for the key → zero hits.
   - Timeout: slow fake tool (add a `sleep` tool) → call times out, run continues to a
     tool-error result (the agent may retry within budget), outcome `timeout` in metrics.

## Style constraints (binding)
- One client module + one registry-merge function. No plugin framework, no dynamic tool
  discovery UI plumbing (that is UI-track U3).
- New deps: `@modelcontextprotocol/sdk` only.
- Server labels/tool names go in logs; args/results never do (§17.2 content rules).

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests stay green — including the entire S5b suite (the broker path is now load-bearing).

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Do NOT git commit.

> **Built, with deviations.**
>
> **Built as specified:**
> - `packages/mcp` — migration `0013` (`mcp_servers`, per-transport zod config, `secret_name`
>   nullable, never a value column); `client.ts`'s `createMcpRunClient` (one `Client` per
>   configured server, lazy-connected, `listTools` cached per client); `checkMcpCall` first,
>   then a per-run call budget (`limits_json.mcp.max_calls`, default 20 — a breach throws,
>   ending the run) and a per-call timeout (`limits_json.mcp.call_timeout_ms`, default 60s, via
>   the SDK's own `RequestOptions.timeout` — a timeout is a recoverable tool error, not a
>   throw); trace entries for every call (args/result, opt-out via the `action` storage
>   category) and `mcp_calls_total`/`mcp_call_duration_seconds{server,outcome}`.
> - The registry merge — `packages/agent/src/asset-tools.ts`'s `buildAssetToolRegistry`,
>   assembling `assets.*` (imported from `@tabductor/assets`, untouched), `mcp.<server>.<tool>`
>   for every tool the run's configured servers list, and `emit`/`done`/`fail`. No `page.*`,
>   `network.*`, `secrets.*` — `mcp-registry-isolation.test.ts` proves it both directions.
>   Results wrap in the loop's own `untrustedBlock` (extended, not duplicated); a returned URL
>   has no navigation tool to feed and a returned path has no host-filesystem tool to feed —
>   the S5d asset-namespace resolution seam mentioned in this doc did not need a TODO because
>   S5d had already landed by the time this subphase started (fork point `e8e653b`).
> - Testkit fake MCP server (`apps/testkit/src/mcp-fake-server.ts`, spawned the same
>   `node --import tsx` way `docker-compose.yml` runs this repo's own entry points): `echo`,
>   `imageStub` (fixed base64 PNG), `sleep`, and `FAKE_MCP_REQUIRE_KEY_ENV` — an env-var-named
>   gate every tool checks, the credential test's fixture.
> - System tests: `mcp-client.test.ts` (echo → untrusted-data delimiter reaches the next LLM
>   request, traced; call-budget breach fails the run typed; timeout → recoverable tool error,
>   run continues), `mcp-registry-isolation.test.ts` (both directions, with a positive control
>   so an accidentally-empty registry can't pass by omission), `mcp-credential-hygiene.test.ts`
>   (the key reaches the server and nowhere else — trace, LLM requests, and LLM responses all
>   grepped for zero hits — **plus a negative control**: the identical fake server genuinely
>   refuses the call when nothing injects the credential, proving the positive result is
>   load-bearing rather than a server that always says yes).
>
> **Deviations:**
> 1. **Loop reused, not forked** — argued in `packages/agent/src/loop.ts`'s own doc comment.
>    `runAgentLoop`'s only browser-specific line was building the tool registry from a
>    `RunSession`; everything else (turn-taking, the `1 + 2*step` message-count invariant,
>    step budget, transcript replay) was already kind-agnostic. Extracted that one line: the
>    loop now takes a prebuilt `tools: AgentTool[]`, and each executor (`buildToolRegistry` for
>    browser, `buildAssetToolRegistry` for asset) builds its own before calling it. One
>    incidental fix fell out of this: the system prompt's "perception is returned by every
>    `page.*` call" instruction now only appears when the registry actually has `page.*` tools
>    — an asset run's prompt no longer references a step that kind has no tool for.
> 2. **`createAssetExecutor`, `packages/agent/src/asset-executor.ts`** — the real `(asset, ai)`
>    path, composing the tool registry + loop behind the engine's `TaskExecutor` contract with
>    no session to acquire (no pool, no CDP endpoint — an asset run's "session" is the tool
>    registry, the trace, and this run's MCP connections). `executor.ts`'s emit
>    dedupe-claim/trigger-schema/step-budget/result-mapping logic was extracted to
>    `executor-shared.ts` rather than duplicated, since none of it was ever browser-specific
>    either — both executors now import the same four functions.
> 3. **`apps/engine/src/main.ts` re-registration**: the S5a stub `AssetExecutor` moves from
>    `(asset, ai)` to `(asset, stub)` — the same slot `StubExecutor` occupies for
>    `(browser, stub)` — and the real executor takes `(asset, ai)`, gated on a live LLM key
>    exactly the way `(browser, ai)` is gated (no endpoint check needed; an asset run has none
>    to acquire). `kind-constraints.test.ts`'s existing test that drives `AssetExecutor` under
>    an explicit `(asset, ai)` registration in its own hand-built rig is unaffected — it never
>    touches `main.ts`'s registry.
> 4. **The secrets broker's first composition-root wiring.** `packages/secrets` existed
>    (S5b) but nothing in `apps/engine` constructed one — `secrets.fill` isn't wired into the
>    browser registry as of this subphase either, a later subphase's business. This subphase
>    adds `SECRETS_KEK_FILE_PATH` to `packages/core`'s config (default
>    `./data/secrets-kek.json`, self-initializing, so a clean checkout still needs no
>    environment) and constructs one `SecretsBrokerHandle` in `main.ts`, passed to
>    `createAssetExecutor` for `injectIntoMcpArg`/`redeemMcpHandle` only — never the
>    browser-only `fill`. `resolveRun` always answers "no live session," honestly: nothing
>    registers one yet, and the MCP path never calls it (`broker.ts`'s own comment: an
>    asset-node run has no page to bind an origin to).
> 5. **`config_json`'s stdio schema gained two fields beyond "command+args+env names"**: `cwd`
>    (where to spawn from — a transport detail, not a credential, needed to make the testkit
>    fake server's bare `"tsx"` import specifier resolve regardless of the caller's own working
>    directory) and `secretEnvVar`/`secretHeader` (the *name* of the env var/header the redeemed
>    secret lands in — never a value, which is what keeps "config_json never contains a
>    credential value" true by construction rather than by convention).
> 6. **A best-effort JSON-Schema→zod bridge** (`asset-tools.ts`'s `jsonSchemaToZod`), not a
>    full implementation or a new dependency: MCP tools declare JSON Schema, this codebase's
>    `AgentTool.parameters` is zod everywhere else, and introducing a JSON-Schema-native path
>    through `llm.ts`/`llm-live.ts` for one caller would have meant a second schema
>    representation crossing the whole tool-calling stack. Handles object/string/number/
>    boolean/array — everything the testkit fake server (and realistically most tool schemas)
>    actually declare — and falls back to `z.unknown()` rather than guessing wrong on anything
>    richer (`oneOf`, `$ref`, …). The server still validates for real; this buys a fast local
>    tool-error instead of a round trip on a malformed call.
> 7. **All four `mcp-*.jsonl` transcripts are hand-authored**, not recorded — no
>    `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` was present in this environment, so recording against
>    a live model was not possible here (unlike part of S4b's set, which did record). Each
>    scenario is also independently one a live model plausibly could not be prompted into
>    anyway without the prompt giving away the answer (call a tool exactly N times to breach a
>    budget on purpose; wait on a tool slower than a number the model is never told) — the
>    `fixtures/transcripts/README.md` table records this per file, following the S4b precedent.
> 8. **`db-schema.test.ts`'s `EXPECTED_TABLES`** gained `mcp_servers` — a pre-existing test
>    this subphase's migration necessarily touches, not new test surface.
>
> Verification: `pnpm install && pnpm build && pnpm lint && pnpm test` green twice — 226 tests
> in 52 files (225 passed, 1 skipped keyless), no flakiness observed across both runs.
> `next build` in `apps/web` green. No leaked Chrome, test databases, or MinIO buckets after
> the run. The entire S5b suite stayed green (the broker path is load-bearing now, for real,
> not just in principle).
