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
