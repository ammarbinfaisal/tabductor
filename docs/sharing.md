# Shared Workflows — A Public Read Surface

> **Amendment (2026-08-10, `event-centric-model.md` / EC1):** visibility mechanics moved
> with the event entity. `public` now lives on the workflow-version-scoped `event_defs`
> row (one per `(version, type)`), declared as `graph.events[].public` in the document —
> not on per-emitter emit declarations, which no longer exist. Everything this document
> *means* survives unchanged: opt-in per event type, default deny, versioned with the
> graph, deny-wins enforcement from the current version, SQL-level filtering, whole shape
> or nothing. The structural claim about platform events also survives: system types have
> no event entity, so nothing can mark them public. `publicGraph` now returns an `events`
> entity list plus per-task `emits`/`consumes` type lists, with `edges` derived for
> rendering; the visibility preview lists events with their emitters.

**Version:** 0.1 (extends `techical_plan.md` 0.5)
**Status:** Specifies **shares** — an unguessable link that lets anyone watch a workflow's graph, triggers, runs, events and produced assets, live or historical, without an account. Covers the token model, the per-event-type visibility manifest, the SQL-level filtering rule that makes the manifest enforceable, the public HTTP posture, and Threats 13–17.

Decisions incorporated from review: visibility is **opt-in per event type, default deny**; the manifest is versioned with the graph, not stored beside it; the whole graph shape is shared or nothing is; run error text is never public.

---

## 1. Purpose and Scope

A workflow that runs unattended is invisible. Its author wants to point a colleague, a client, or a public audience at a URL and have them see the thing working: the graph, what triggered it, which runs are in flight, what events fired, what data those events carried, and what files came out — updating as it happens, and browsable afterwards.

This document specifies that surface. It is deliberately narrow:

**In scope.** Read-only public visibility into **a workflow's own execution**: graph shape, schedules and triggers, run status and timings, event timeline with lineage, opted-in packet bodies, and assets referenced by those packets.

**Out of scope, still.** A marketplace or template library — copying someone else's workflow into your own account is a different feature with a different threat model (§16 Threat 11 in `graph-compilation-llm.md` already says imported workflows arrive with all grants pending; that is the seed of that design, not this one). Also out: public *write* of any kind, comments, forking, and any authenticated multi-user notion. `techical_plan.md` §1 keeps multi-tenant organizations out of v1 and this feature does not need them — a share is a capability, not an identity.

**Naming, and why it matters.** `publishVersion` already means "compile a graph document into rows" (`packages/engine/src/graph.ts`). This feature never uses the word *publish*. It is a **share**: `workflow_shares`, "shared workflow", "the public view", `/s/<token>`. Two meanings of publish in one codebase is a bug waiting to be written.

## 2. The Share Object

### 2.1 A share link is a credential

A share URL grants read access to whoever holds it. That puts it in the same class as the CDP `wss://` endpoint of §16 Threat 5, and it gets the same treatment:

- The token is **32 random bytes**, base64url — unguessable, not derived from the workflow id. Enumerating workflow ids must reveal nothing.
- It is **stored hashed** (`sha256`), never in plaintext. A dump of `workflow_shares` yields no working links.
- It is **shown once**, at creation. A `token_prefix` (first 8 characters) is stored so the owner can tell their shares apart in the UI, and so a support conversation can identify one without transmitting it.
- It is **never logged** — not in pino lines, not in OTel attributes, not in the URL recorded by any request log. §17.2 already forbids secrets and CDP URLs in telemetry; the share token joins that list.

Losing a link is recoverable by **rotating** (new token, same share, same manifest), not by retrieving the old one. This is a deliberate trade: making links re-readable means storing them in a form that a database compromise turns into a mailing list of live URLs.

### 2.2 Lifecycle

| Operation | Effect |
|---|---|
| `share.create(workflowId)` | New row; returns the plaintext token exactly once, together with a **visibility preview** (§3.4) |
| `share.rotate(shareId)` | New token, old hash discarded; manifest and history unchanged |
| `share.revoke(shareId)` | Sets `revoked_at`; every subsequent request 404s |
| `share.list(workflowId)` | Prefixes, creation and revocation times — never tokens |

Revocation is **immediate and uncached**. Every public request resolves the token to a share with one indexed lookup and re-checks `revoked_at is null`; there is no resolved-share cache to invalidate. One extra index probe per request is cheaper than a revocation that takes effect eventually.

A share is per **workflow**. Deep links to a run or an event live inside it (`/s/<token>/runs/<id>`) and are scoped by the same share, so revoking kills them all.

## 3. The Visibility Manifest

### 3.1 Three tiers, fixed

**Always visible once shared.** Workflow name; graph shape — nodes with their `name`, `kind` and `mode`, and all edges with their event types; schedules (cron expression, timezone, missed and overlap policy); run rows as `{status, attempt, started_at, ended_at, duration}`; the event timeline as `{type, occurred_at, source node}`; lineage edges between events.

**Never visible.** Task prompts. `limits_json` in any form, including StubExecutor scripts and Python source. CDP endpoints, secrets, secret names, grants, MCP server configuration. Workflow and task **ids** are replaced by share-scoped opaque ids so a leaked share cannot be used to address rows through some future authenticated endpoint. And — the one that is easy to get wrong — **`runs.error` free text** (§3.3).

**Visible if and only if opted in, per event type.** Packet bodies, and the assets those packets reference (§4.4).

### 3.2 The manifest lives in the graph document

Visibility is declared on the emitted event, in the graph document that `publishVersion` already compiles:

```ts
// packages/engine/src/graph.ts — GraphTask.emits[]
{ type: "tweet.detected", packetSchema: {...}, public: false }   // default
```

`publishVersion` projects it into a new column, `event_defs.public boolean not null default false`, exactly as it already projects packet schemas and schedules. Two properties follow, and they are the reason the manifest is not a side table keyed on `(workflow_id, event_type)`:

1. **A graph edit cannot silently widen a share.** A node added in version N+1 arrives with `public: false`, because that is the schema default. There is no state left over from version N to inherit and no code path that could carry a stale `true` forward.
2. **Visibility is versioned, reviewable and diffable** along with everything else about the graph. "When did this become public?" is answered by the same version history that answers "when did this node change?".

### 3.3 Error text is not public

`runs.error` is a free-text string produced by executors. It routinely contains URLs, selector fragments, TeX logs, Python tracebacks and — once browser nodes exist — snippets of page content. Publishing it would leak, through the back door, exactly the content the manifest exists to gate.

The public view therefore shows a bounded **error class** derived in the read model, never the string:

`timeout` · `retries_exhausted` · `engine_restart` · `packet_invalid` · `loop_budget_exceeded` · `no_executor` · `sandbox_kill` · `policy_denied` · `other`

A bounded set is safe to render because it cannot carry content. The owner still sees the full string in their own view.

### 3.4 The whole graph, or nothing

There is no per-node hide flag. A partially hidden graph is a misleading graph: edges into the hidden node dangle, its existence is inferable from the gap, and the viewer is shown a topology that is not the topology. If a node is too sensitive to show, the workflow is too sensitive to share.

What *is* shown at share-creation time, and again at publish whenever the manifest changes, is a **visibility preview**: the exact list of node names, event types, and packet fields that a viewer will be able to read. Widening is a deliberate act with a diff in front of it (§16 Threat 13).

### 3.5 System events

Platform events — `run.completed`, `run.failed`, `system.loop_budget_exceeded`, `schedule.fired`, `manual.trigger` — appear in the public timeline as **type and timestamp only**. Their packets are never public and there is no flag that could make them so: `public` lives on `event_defs`, which only exists for user-declared emissions. System events have no `event_defs` row, so the structure of the schema is what enforces this, not a check somewhere.

This is also how the user's ask for "triggers" is met: a cron fire is a visible `schedule.fired` at a visible timestamp against a visible schedule, and a hand-trigger is a visible `manual.trigger`.

## 4. The Public Read Path

### 4.1 Filter in SQL, not in the router, and never in the component

**The controlling rule of this feature.** The public read models select only what the manifest permits; the packet column is not selected at all for a non-public event type. A bug in a tRPC procedure, a serializer, or a React component then cannot leak a packet, because the packet was never fetched.

The alternative — fetch everything, redact on the way out — puts the security property in the layer most likely to be refactored by someone who does not know it is load-bearing. Do not build it that way.

The reason this needs saying twice: today `listWorkflows(db, userId?)` in `packages/engine/src/queries.ts` takes an optional owner filter and the only caller passes nothing, so it returns every workflow in the database. That function, and anything shaped like it, must be unreachable from the public path.

### 4.2 Read models and router

New functions in `packages/engine/src/queries.ts`, each taking a **required** `workflowId` and an explicit `publicTypes: ReadonlySet<string>`:

| Function | Returns |
|---|---|
| `publicGraph(db, versionId)` | Nodes (name, kind, mode, position), edges, schedules. No prompts, no limits |
| `publicRunList(db, {workflowId, cursor, limit})` | Status, attempt, timings, error **class** |
| `publicEventList(db, {workflowId, publicTypes, cursor, limit})` | Type, timestamp, source node; packet only where the type is public |
| `publicEventGet(db, {workflowId, publicTypes, eventId})` | One event plus depth-capped lineage; packets of non-public types omitted, their existence and type retained |

They live beside the existing read models and reuse the same keyset pagination. The public tRPC router (`apps/web/src/server/routers/public.ts`) gets its own context — `{ db, share }`, where `share` is the already-resolved row — and calls nothing else.

Lineage deserves a note. A chain `A(public) → B(private) → C(public)` renders as three links with B's body missing. This reveals that an event of type B occurred, which the viewer already knew was possible from the graph, so it is not a new disclosure — and hiding the hop instead would draw a causal edge that does not exist.

### 4.3 Live and historical are the same path

The public view polls at 2s with the existing `usePolling` (`apps/web/src/lib/store.tsx`), like the owner's runs table and event feed. No websockets, no SSE, for U0's stated reason: the outbox already owns the engine's latency budget, and a second one on the read side is a second thing to debug. "Live" here means a 2s-stale read of durable rows, which is what the owner sees too.

Historical browsing is the same procedures with a cursor. There is no separate archive path and no snapshot: a viewer who opens the link a month later sees the same event feed, scrolled back.

### 4.4 Assets need no ACL of their own

An asset is publicly readable **iff it is referenced by a packet of a public event type under a live share**. Nothing to configure, nothing to keep in sync, and no way to publish an asset the viewer cannot already see the packet for.

Mechanically: an asset ref is `{asset_id, path, mime, sha256}` (§13.5). The public blob route takes the share token and an asset id, re-derives the permission by looking for that `asset_id` in a public packet of that workflow, and streams the blob under the headers in §5.2. Assets do not exist yet — this is a **forward contract on S5d**, which must implement the derivation query as part of its own subphase rather than leaving it to be bolted on.

## 5. Public Routes and HTTP Posture

### 5.1 Routes

```
/s/<token>                    graph + live run summary
/s/<token>/runs               runs table (keyset paginated)
/s/<token>/runs/<run_id>      one run: its trigger, its emissions
/s/<token>/events             event feed
/s/<token>/events/<event_id>  one event: packet if public, lineage
/s/<token>/assets/<asset_id>  blob stream (S5d)
```

Server components resolve the share and call the public router through `createCaller`, as the owner's pages already do. Unknown, malformed and revoked tokens are **indistinguishable**: all three render the same 404, with no timing difference worth measuring — a "revoked" page confirms a workflow existed.

### 5.2 Headers

| Header | Where | Why |
|---|---|---|
| `X-Robots-Tag: noindex, nofollow` | all `/s/*` | A share is unlisted; a crawler that indexes one has published it |
| `Referrer-Policy: no-referrer` | all `/s/*` | The token is in the path. Without this, any outbound click leaks it in `Referer` |
| `Content-Disposition: attachment` | assets | Never render a user-supplied blob inline on our origin |
| `X-Content-Type-Options: nosniff` | assets | Defeat MIME confusion |
| `Content-Security-Policy: sandbox` | assets | Belt and braces if a browser renders it anyway |

MIME on asset responses comes from a **narrow allowlist** derived from what the asset store can produce (`application/pdf`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `text/csv`, `text/markdown`, `image/png`, `application/json`, …); anything else is served as `application/octet-stream`.

The public pages themselves render node names, event types and packet values that originate from LLM output and scraped web content. React escapes by default; the rule is simply that **no public component ever uses `dangerouslySetInnerHTML`**, and packet values render as text or as `<pre>`-formatted JSON, never as markup.

### 5.3 Rate limiting

Per-share and per-IP token buckets, in-process in the web app, with a hard page-size cap on every list procedure and the existing depth cap on the lineage CTE (`packages/bus/src/lineage.ts`). In-process means per-instance, which is honest and sufficient for single-node; when the control plane is replicated this moves to a shared counter, and Postgres is the place for it — this codebase does not take a Redis dependency for a rate limiter (§6 of the tech plan already rejects reaching for infrastructure early).

## 6. Security Analysis (extends `techical_plan.md` §16)

**Threat 13 — Packet content disclosure.** Packets carry whatever the emitting node put in them: scraped page text, personal data, business figures. The controls are structural rather than procedural — default deny on a schema default (§3.2), a manifest that versions with the graph so widening is an explicit, diffable act, SQL-level filtering so no presentation bug can leak (§4.1), and a visibility preview shown at share creation and at every manifest change. Residual risk, stated honestly: a user who marks an event public gets exactly what they asked for, including whatever an injected agent stuffed into that packet (§16 Threat 2). Sharing multiplies the consequence of Threat 2; it does not change its likelihood.

**Threat 14 — Share token leakage.** The token is a bearer credential in a URL, which is the leakiest place to put one. Mitigations: 256 bits of entropy so it cannot be found; hashed at rest so it cannot be stolen from the database; `Referrer-Policy: no-referrer` so it cannot escape by a click; `noindex` so it cannot be indexed; never logged so it cannot be grepped out of an operator's Loki; rotate and revoke so a suspected leak is a ten-second fix. Residual: a viewer can always forward the link. A share has no notion of *who* is looking, by design — adding one would require the accounts §1 puts out of scope.

**Threat 15 — Stored XSS and drive-by via public content.** Assets are attacker-influenceable bytes served from our origin, and packet strings are attacker-influenceable text rendered into our HTML. Controls in §5.2. The strongest available additional measure — serving blobs from a separate origin — is recommended for any deployment where the control plane holds a session cookie, and is a deployment note rather than a code change (`BLOB_PUBLIC_ORIGIN`).

**Threat 16 — Unauthenticated read amplification.** The public path is the only surface in the system that executes queries for an unauthenticated caller. Controls: rate limits per share and per IP, hard page-size caps, keyset pagination (already the shape of the existing read models, so no offset scans), and the depth-capped lineage CTE. The recursive lineage walk is the one genuinely expensive query and must never run unbounded on this path.

**Threat 17 — Inference from metadata.** Even with every packet private, timings, run counts, failure rates and schedule shape are visible, and they say things: when your business day is, how often a scrape fails, how many items a batch carries. This is accepted — it is the substance of what "watch the flow progress" means — with two carve-outs where the leak is content rather than shape: error text (§3.3) and event *counts by private type*, which are shown as timeline entries but not aggregated into per-type totals a viewer could difference against.

## 7. Public Observability (`techical_plan.md` §17.3)

§17 defines two audiences: users, who see run traces, and operators, who see OTel. Shares add a third — **the public viewer** — and it gets its own one-line content rule, which belongs in the design doc next to the other two:

> The public view shows exactly the manifest, and nothing derived from anything outside it.

Nothing outside the manifest may be summarised, aggregated, sampled or hinted at in a public surface. In particular: platform telemetry is never public (it is operator exhaust), run traces are never public (they are the owner's debugging data, governed by the owner's opt-outs and full of content nobody consented to share), and no future "workflow health score" may be computed over private packets and shown as a number.

Two new §17.2 metric rows, under the binding-name rule:

| Metric | Type | Labels |
|---|---|---|
| `share_views_total` | counter | `result=ok\|unknown\|revoked\|rate_limited` |
| `share_asset_reads_total` | counter | `outcome=ok\|denied\|not_found` |

`share_views_total{result="unknown"}` climbing is someone guessing tokens. It belongs on the security-signals dashboard, which is the board built for series that should sit near zero.

## 8. Data Model Additions (extends `techical_plan.md` §14)

```
workflow_shares(id, workflow_id, token_sha256 unique, token_prefix,
                created_at, revoked_at)                  -- token never stored in plaintext

-- event_defs gains one column:
event_defs.public boolean not null default false          -- projected from graph_json
```

That is the whole schema change. There is no `share_grants`, no per-asset ACL and no public-access log table: asset visibility is derived (§4.4), and access counting is a metric, not a row — a share view is not product data, and writing a row per public page load would make a DoS cheaper.

## 9. Build Plan Placement

The prerequisite is S2c, which is done. This track is independent of S3–S8 and can land next.

- **S2d — share model + public read API.** Migration (`workflow_shares`, `event_defs.public`), `GraphTask.emits[].public` in the graph document and its projection in `publishVersion`, the four public read models, the share management procedures, the public tRPC router and its context, rate limiting, error-class derivation. System tests are the contract, as always: a non-public event type's packet must be absent from the query result, not merely absent from the response.
- **U0.5 — public workflow view.** The `/s/[token]` route group. Reuse rather than fork: lift the React Flow node/edge mapping out of `apps/web/src/components/graph-editor.tsx` into a shared module, and parameterize `runs-table.tsx` and `event-feed.tsx` by the fetcher they call, so the public and owner views cannot drift. Share management UI (create, preview, rotate, revoke) in the owner's workflow page. Hook policy unchanged — `usePolling` and `useStoreBridge` only.
- **S5d addendum.** The asset store's subphase must implement the public asset derivation and the blob route headers (§4.4, §5.2) as part of its own deliverables. Assets are the one part of the user's ask this track cannot deliver on its own.

## 10. Decisions and Open Questions

Resolved in this document:

1. **A share is an unguessable capability URL, hashed at rest, shown once** — rotate to replace, revoke to kill; unknown and revoked are indistinguishable.
2. **Visibility is opt-in per event type, default deny**, declared in the graph document and projected to `event_defs.public`.
3. **The manifest versions with the graph** — a new node arrives private because that is the schema default, not because a check said so.
4. **The whole graph shape is shared, or nothing is** — no per-node hiding.
5. **Filtering happens in SQL** — the public read models never select a private packet.
6. **Run error text is never public**; a bounded error class is.
7. **System event packets are never public**, enforced by the absence of an `event_defs` row rather than by a check.
8. **Asset visibility is derived, not configured** — public iff referenced by a public packet under a live share.
9. **No websockets** — the public view polls at 2s like every other live surface here.

Open:

1. **Expiring shares** — a `expires_at` alongside `revoked_at` is trivial to add and probably wanted for client-facing links. Deferred only because nobody has asked for a duration.
2. **Per-field packet redaction** — today opt-in is per event type; a packet with one sensitive field forces all-or-nothing. Per-field masking is a natural extension of the same manifest (the packet schema already enumerates fields) and should be designed before someone works around it by splitting a node in two.
3. **Separate blob origin** as a default rather than a deployment note (§16 Threat 15) — depends on whether the control plane ever holds a session cookie, which depends on auth, which is out of scope.
4. **Owner-visible view counts** — pleasant, but it means writing a row per view and re-opens Threat 16's cost argument. Metrics give the operator the number; the owner currently gets nothing.
5. **Interaction with trace retention** — a share outlives the runs it displays only as long as the rows do. Whether sharing should pin retention for the shared workflow belongs with tech plan §18 open question 3.
