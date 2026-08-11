# S2d — Share model + public read API

> **Historical build order, amended by EC1.** Visibility re-homed from the per-emitter
> declaration to the event entity: `graph.events[].public` → `event_defs.public` keyed
> `(version, type)`. What the subphase enforces is unchanged. Current model:
> `docs/event-centric-model.md` §4.

You are implementing subphase S2d. Read, in order:
1. This file (authoritative).
2. `docs/sharing.md` — the whole document. It is the design; this file is the build order.
3. `docs/impl-phases.md` — "Sharing track — S2d + U0.5".
4. `docs/techical_plan.md` — §5 (share visibility as a graph rule), §14 (data model),
   §16 Threats 13–17, §17.3.
5. `docs/subphases/ROADMAP.md` — the share-visibility binding block and the stack rules.

Existing code to reuse (read first): `packages/engine/src/graph.ts` (`graphSchema`,
`checkGraph`, `publishVersion`, `readGraph` — the document→rows projection you are extending),
`packages/engine/src/queries.ts` (existing read models and their keyset pagination),
`apps/web/src/server/` (`trpc.ts` context and `domainErrors` middleware, the four routers),
`packages/db/src/schema.ts` + `migrations/`, `packages/core` (`newId`, `AppError`),
`packages/telemetry/src/metrics.ts` (the registry you add two rows to).

## Scope

The backend of shared workflows: a share is an unguessable link that lets anyone read a
workflow's graph, triggers, runs, events, opted-in packets and (later) assets. **UI is U0.5
and is not yours.** Assets do not exist yet — implement nothing for them; `docs/impl-phases.md`
puts the public asset route in S5d as a forward contract. Auth does not exist and you are not
adding it: a share is a capability, not an identity.

## Deliverables

1. **Migration (`packages/db`, additive):**
   - `workflow_shares(id text pk, workflow_id text not null references workflows on delete
     cascade, token_sha256 text not null unique, token_prefix text not null, created_at
     timestamptz not null default now(), revoked_at timestamptz null)`. Index on
     `token_sha256` is the unique constraint; that lookup is on every public request.
   - `event_defs.public boolean not null default false`.
   - Nothing else. There is no share-grant table and no access-log table — asset visibility
     is derived (`sharing.md` §4.4) and views are a metric, not a row.

2. **Graph document + publish (`packages/engine/src/graph.ts`):**
   - `GraphTask.emits[]` gains `public: z.boolean().default(false)`.
   - `publishVersion` projects it into `event_defs.public`; `readGraph` round-trips it from
     the rows, like every other event-def field.
   - **No `checkGraph` rule is needed and none should be added.** The safety property —
     a node added in a later version arrives private — comes from the zod default, not from
     a validation pass. Write a test that proves it rather than a check that asserts it.

3. **Public read models (`packages/engine/src/queries.ts`)** — `publicGraph`,
   `publicRunList`, `publicEventList`, `publicEventGet`. Each takes a **required**
   `workflowId`; the two event models take an explicit `publicTypes: ReadonlySet<string>`.
   - **They filter in SQL.** For a non-public event type the `packet` column is not selected.
     This is the subphase's central rule: a router, serializer or component bug must not be
     able to leak a packet, because the packet was never fetched. Do not fetch-then-redact.
   - `publicGraph` selects name/kind/mode/position, edges and schedules — never `prompt`,
     never `limits_json`.
   - `publicRunList` returns status, attempt, timings and an **error class**, never
     `runs.error`. Derive the class in the query: `timeout`, `retries_exhausted`,
     `engine_restart`, `packet_invalid`, `loop_budget_exceeded`, `no_executor`,
     `sandbox_kill`, `policy_denied`, `other`. A bounded set is safe to render; free text
     is not (`sharing.md` §3.3).
   - `publicEventGet` reuses the depth-capped lineage walk (`packages/bus/src/lineage.ts`).
     A private hop keeps its type and timestamp and drops its packet — do not omit the hop,
     which would draw a causal edge that does not exist.
   - Reuse the existing keyset pagination; add a hard `limit` ceiling on both list models.

4. **Share procedures (`apps/web/src/server/routers/share.ts`)** — `create`, `rotate`,
   `revoke`, `list`, on the owner's side of the API.
   - Token: `crypto.randomBytes(32)` base64url. Store `sha256` and the first 8 characters.
     **`create` and `rotate` return the plaintext exactly once and it is never stored,
     never logged, and never placed in a span attribute or a pino line.**
   - `create` also returns a **visibility preview**: the node names, event types and packet
     schema field names a viewer will be able to read.
   - `list` returns prefixes and timestamps. There is no procedure that returns a token.

5. **Public router (`apps/web/src/server/routers/public.ts`)** with its own context.
   - The context resolves the token to a live share (`revoked_at is null`) on **every**
     request — one indexed lookup, no cache, so revocation is immediate.
   - It exposes `{ db, share }` and nothing else. It must be structurally impossible to
     reach `listWorkflows` from here: that function takes an optional `userId` and its only
     current caller passes nothing, so it returns every workflow in the database.
   - Unknown, malformed and revoked tokens produce the **same** `NOT_FOUND`. A distinct
     "revoked" response confirms a workflow existed.
   - Rate limit per share id and per client IP (in-process token bucket; per-instance is
     honest for single-node and says so in a comment). Over limit → typed error, and the
     metric below.

6. **Telemetry:** `share_views_total{result=ok|unknown|revoked|rate_limited}` and
   `share_asset_reads_total{outcome=ok|denied|not_found}` added to
   `packages/telemetry/src/metrics.ts` under those exact names (§17.2 names are binding).
   The second has no call site yet — S5d adds it. Register it anyway so the dashboard row
   exists. No token, no packet, no workflow name in any signal.

7. **System tests** (`tests/system/`, content-named, e.g. `sharing.test.ts`):
   - **Assert on the read model directly**, not through the router: a private event type's
     packet is absent from `publicEventList`'s *result object*. This is the test that
     encodes the SQL-filtering rule; a test that only checks the HTTP response would pass
     against a fetch-then-redact implementation.
   - Publish a version adding a node with a new emit → that emit is private.
   - Mark an emit public, publish, then publish again without the flag → private again.
   - Revoked / unknown / malformed tokens are indistinguishable.
   - A run failed with a content-bearing error string exposes only its class.
   - Lineage across a private hop: hop present, packet absent.
   - `limit` beyond the ceiling is clamped, not honoured.
   - `publicGraph` output contains no `prompt` and no `limits` key at any depth.
   - The whole existing suite stays green — `event_defs.public` is additive and
     `publishVersion`'s existing behaviour must not move.

## Style constraints (binding)

- No new dependencies. Tokens use `node:crypto`; the rate limiter is a Map and a timestamp.
- No auth, no sessions, no `ctx.userId`. That is a separate change and this one must not
  half-do it.
- Filtering lives in `packages/engine/src/queries.ts`. Do not put a redaction helper in
  `apps/web` — that is the layer most likely to be refactored by someone who does not know
  it is load-bearing.
- Do not use the word *publish* for this feature anywhere in code, comments or docs.
  `publishVersion` already means something else. It is a **share**.

## Verification

```
pnpm install && pnpm build && pnpm test && pnpm lint
```

All prior tests stay green; run twice. Verify the migration applies cleanly to a database
holding pre-S2d rows and that existing `event_defs` read back as `public = false`.

## Report back

What you built, deviations + why, commands + outcomes, flakiness noticed. Call out
explicitly whether any code path can reach a private packet's bytes, and how you know.
Do NOT git commit.
