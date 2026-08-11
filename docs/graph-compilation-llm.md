# LLM Graph Compilation — One Prompt to a Running, Self-Optimizing Workflow

**Version:** 0.2 (extends `techical_plan.md` 0.6)
**Status:** Specifies the third node kind (**decision**), the **workflow data store** (per-workflow Postgres schema + role pair), and the **graph compiler** — the LLM pipeline that turns a plain-language intent into a checked, versioned graph: node prompts, kinds, grants, event declarations, and store schema. Ends with how this composes with the §11 script compiler into a single compilation ladder.

Decisions incorporated from review: decision node accepted as a third kind; store is a Postgres schema per workflow (not SQLite, not a separate database); store schema compiled from a prompt like packet schemas (tech plan Decision #2); DB roles per workflow as defense in depth; decision nodes are schedule- **and** event-triggered.

**Changes in 0.2 (2026-08-11), against `event-centric-model.md`:** this document is written
against the event-centric wiring model rather than the edge model it was drafted on. Events are
workflow-version entities; tasks declare `consumes`/`emits` by type; there are no authored edges,
so P1 produces event entities and bindings, and the §5 checks that walked edges now walk
declarations. **P3's packet-schema half has shipped** as EC1 — the publish-time compiler with
carry-forward hashing, an ajv-strict gate and a per-event compile report — so what remains of P3
here is the store schema, compiled in the same pass for the naming-coherence reason §4.2 gives.
The rest of P1–P5 is unchanged and still S8.

---

## 1. Purpose and Scope

The platform already has one compiler: the §11 script compiler, which lowers a browser task's AI behavior into static JS from traces. This document adds the compiler *above* it: the **graph compiler**, an LLM pass that runs at authoring/save time and produces the workflow definition itself. Together they form a ladder:

```
L0  user intent            one prompt, or conversational edits
 │        graph compiler (LLM, save time)
 │        ▼ deterministic gate: schema/DDL/graph lints          §5
L1  graph definition       nodes + kinds + prompts + grants(proposed)
 │                         + event entities (description → packet schema)
 │                         + emits/consumes bindings + store schema + schedules
 │        script compiler (LLM, from traces, §11)
 │        ▼ deterministic gate: lint, sandbox, guards
L2  compiled JS            per browser task (and later, decision task)
```

The invariant that makes this safe, restated from §2 principle 2 and applied at every level: **every level's author is an LLM; every level's gatekeeper is deterministic; every level's executor is sandboxed.** The graph compiler's output is never trusted because an LLM wrote it — it is trusted because it passed the gate in §5, exactly as compiled JS is trusted only because it passed the §11/§12 lint-and-sandbox gate.

Deopt flows *up* the ladder (L2 guard failure hands control to the L1 agent mid-run, §11); recompilation flows back *down*. Graph edits at L0/L1 invalidate L2 artifacts per task, not per workflow (§6.3).

## 2. The Third Kind: `kind=decision`

### 2.1 Definition

A decision node reads the workflow data store, optionally combines that with a trigger packet, and decides what work to emit. It is the planner of the graph: "given what we have already processed, what should be browsed next?"

Updated kind taxonomy (supersedes the two-kind table in tech plan §4):

| Kind | Tool registry | Triggers | Store access | Compilable (L2) |
|---|---|---|---|---|
| `browser` | `page.*`, `network.*`, `secrets.fill`, `emit` | schedule + event | **none** | yes (§11) |
| `asset` | `mcp.*`, `assets.*`, `store.query`, `store.insert`, `store.upsert`, `emit` | event only | read + write | never (§11) |
| `decision` | `store.query`, `emit` | **schedule + event** | **read only** | not in v1; eligible later (§2.4) |

The registries remain **disjoint by design** where it matters: only asset nodes write the store, only browser nodes touch pages, only asset nodes reach MCP. The decision node's registry is the smallest in the system — deliberately, see §8 Threat 9.

Kind-constraint updates to tech plan §5:

- Schedules may bind to `kind=browser` **or `kind=decision`**. Asset nodes remain event-only — an asset node must declare at least one `consumes` type.
- Any kind may consume any event type, whichever kind emitted it. Routing is by type alone (`event-centric-model.md` §2), so kind places no constraint on who may hear whom.
- Browser nodes get **no store tools at all**. The triangle is: decision reads, asset writes, browser neither. Data crosses node boundaries only via validated events, as before.

### 2.2 A decision is a function of (stored state, trigger packet)

Both inputs are optional per invocation, neither is optional in the design:

- **Cron-triggered:** the fire carries an empty packet (§7 of the tech plan); the decision is a function of stored state alone. "Every night, find the next 50 unvisited tweets and emit `browse.request` for each."
- **Event-triggered:** the trigger packet's declared fields are injected into the prompt context exactly as for any consuming node (Decision #2 mechanics, unchanged). The decision is then a join of packet against state. Examples:
  - `run.completed` (system event) from the browser task triggers the decision node to plan the next batch — a backfill loop, bounded by the existing loop budget (§5 graph rules).
  - `tweet.detected` triggers a decision node that consults a stored ranking table and emits `tweet.relevant` only for accounts marked high-priority — stateful routing that a stateless per-packet predicate cannot express.

Decision nodes and mechanical packet filtering are complementary, not competing: a predicate filters one packet with no history; a decision node filters *with* history. That open question (tech plan §18 open #1) survives the loss of edges, but its shape changed — a predicate has no edge row to hang on, so if it returns it attaches to a task's `consumes` declaration, filtering per (consumer, type) rather than per wire. Nothing in this section depends on which way it resolves.

### 2.3 Tool contract

`store.query(sql)`:

- Single SELECT statement. Parsed and rejected otherwise (§4.4).
- Executes under the workflow's **reader role** in a `READ ONLY` transaction with a statement timeout.
- Results are returned to the agent **delimited as data** (same demarcation discipline as MCP results, §13) and **capped**: first N rows plus a count ("… and 4,112 more; refine the query"), mirroring the `network.list` truncation pattern (§9). No unbounded result set ever enters context.
- Per-run query budget (default: 10 queries) enforced by the runtime, like all resource limits (§8).

`emit(type, packet)`: unchanged; the type must be one the node declares in `emits`, and the packet is validated against that event's compiled schema; `emitIfNew` dedupe semantics available as everywhere else.

### 2.4 Compilability (deliberately deferred, deliberately not forbidden)

Tech plan §11 says asset nodes are *never* compiled because MCP output has no stable structure to guard on. Decision nodes are the opposite extreme: their whole behavior is "run a query, loop, emit" — the most deterministic work in the system. A compiled decision script is a parameterized SELECT plus an `emitIfNew` loop, with guards asserting on the **store schema version** (§6.2):

```js
// sketch — not v1
const ok = await ctx.guard.storeSchema(7);   // deopt if the store migrated under us
if (!ok) return ctx.deopt("Store schema changed; re-derive the planning query.", ...);
const rows = await ctx.store.query(
  `SELECT tweet_id, url FROM candidates c
   WHERE NOT EXISTS (SELECT 1 FROM visited v WHERE v.tweet_id = c.tweet_id)
   ORDER BY c.posted_at DESC LIMIT 50`);
for (const r of rows) await ctx.emitIfNew('browse.request', r, { dedupeKey: r.tweet_id });
```

v1 keeps decision nodes in `mode=ai`. But unlike asset nodes, do **not** write "never compiled" into the compiler's task selector — filter on `kind IN ('browser')` for now with a comment that `decision` joins the list when `ctx.store` lands in the static runtime. When it does, a cron-driven planning tick becomes literally free of LLM cost, which is the product's core value claim (§17) applied to the node kind that fires most often.

## 3. The Workflow Data Store

### 3.1 What it is and is not

The store is **shared, schema'd, queryable state scoped to one workflow**: visited-set tracking, backfill cursors with structure, accumulated datasets that decisions are made against. It is not:

- **`task_state`** (§12) — that remains the *private*, unschema'd KV for a single task's cursor. Small, invisible to other nodes, no compilation step. Keep it; the store is for state that must be shared or queried.
- **The asset store** (§13.5) — assets are deliverables (files); the store is operational state (rows). An asset node may of course write both in one run: the generated doc to `/docs/...`, the `visited` row to the store.
- **Trace/event history** — events are the transport, not the database. "Have I seen tweet X" must not be answered by scanning past packets.

### 3.2 Placement: a Postgres schema per workflow, in the same database

Each workflow gets one Postgres schema, `wfdata_<workflow_id>`, in the **same database** as the platform tables. LLM-defined tables live inside it.

**Why the same database — this is the load-bearing decision.** The S1 event bus is a transactional outbox. The asset node's signature move is: write the `visited` row, write the produced asset's metadata, and emit `doc.ready` — atomically. That is only possible if the store row and the outbox row commit in one transaction, which requires one database. Postgres has no cross-database transactions.

**Rejected: one database per graph (or per user).** It buys isolation you can get from schemas + roles (§3.3) at the cost of the outbox atomicity above, plus a connection-pool explosion (a pool per database) and a migration/backup story multiplied by N. If multi-tenant hardening later demands physical separation, the unit is a *cluster per tenant tier*, not a database per graph — and the schema-per-workflow + role model carries over unchanged.

**Rejected: SQLite files in the asset store.** Assets are versioned blobs — every INSERT would version a multi-megabyte binary; concurrent runs writing one file is a locking mess; and it cannot join the outbox transaction. What users actually want from "expose SQLite" is a downloadable dataset, and they get it: an export tool dumps `wfdata_<id>` to a `.db` (or `.csv` per table) **as an asset** — deliverable story intact, SQLite never the live engine.

**Rejected: document/NoSQL store.** The decision node's defining query is relational ("candidates NOT IN visited", ranges, ordering, joins against a ranking table). JSONB columns cover the semi-structured cases inside Postgres.

### 3.3 DB-level isolation: a role pair per workflow

Tool-layer enforcement (PolicyGate) remains the primary control, as everywhere in the system. But the SQL text here is LLM-authored at runtime, so the store gets a second, database-level fence — cheap and mechanical:

- Per workflow, two `NOLOGIN` roles: `wfd_<workflow_id>_r` (SELECT on all tables in the schema) and `wfd_<workflow_id>_w` (SELECT, INSERT, UPDATE, DELETE). Granted to the engine's login role. `ALTER DEFAULT PRIVILEGES` keeps grants current as migrations add tables.
- Every LLM-authored statement executes inside a transaction that begins with `SET LOCAL ROLE wfd_<id>_r` (decision reads) or `_w` (asset writes), plus `SET LOCAL search_path = wfdata_<id>, pg_catalog`, `READ ONLY` for the reader path, and a `statement_timeout`.
- **Neither role has any privilege on any other schema** — not the platform tables, not other workflows' schemas. A validator bug that lets a hostile SELECT through still cannot read `secrets` or a neighboring workflow's data. That is the malicious-actor containment the roles buy.
- DDL is not grantable to either role. Only the migrator (engine-owned, §6.2) creates or alters tables, only at publish time. There is no runtime DDL path at all.
- Statements go over the extended query protocol (parameterized), which is single-statement by protocol — a smuggled `; RESET ROLE; ...` is unrepresentable, independent of the parse gate.

Role count scales fine (roles are catalog rows; two per workflow), and cleanup is `DROP OWNED`/`DROP ROLE` on workflow deletion alongside `DROP SCHEMA ... CASCADE`.

### 3.4 Write path: structured, not raw SQL

Asset nodes write via structured tools, never free-form DML:

| Tool | Contract |
|---|---|
| `store.insert(table, row)` | row validated with **ajv against the compiled table spec** (§5.3) — the same machinery packets use; fails loudly on mismatch |
| `store.upsert(table, row)` | same validation; conflict target is the table's declared primary key |
| `store.query(sql)` | read-back for aggregation (reports); same reader-path rules as the decision node |

`store.delete` is deferred: no v1 use case needs it (visited-sets only grow; corrections are upserts), and a destructive tool with LLM-chosen predicates deserves its own design pass. Rows that need retiring get a status column in the schema instead.

Writes additionally check `store_write_grants(task_id, table_name)` — the exact pattern of `asset_write_grants` (§13.5): reads are open within the workflow, writes are per-task scoped, so one bad task definition has bounded blast radius.

### 3.5 Read path: raw SELECT, fenced

Deciding genuinely needs arbitrary queries — anti-joins, windows, ordering — so the read tool takes SQL. The fences, all mandatory and layered:

1. Parse gate: exactly one statement, statement type SELECT (CTEs allowed, `SELECT ... INTO` and locking clauses rejected).
2. Reader role + `READ ONLY` transaction + pinned `search_path` (§3.3) — so even a SELECT that calls a side-effectful function cannot write, and cannot see other schemas.
3. `statement_timeout` and result cap with truncation notice (§2.3).

Every parse-gate rejection increments `store_sql_rejected_total{reason}` (tech plan §17.2) — a series that should sit at zero, on the security-signals dashboard, because a nonzero rate is either a prompting bug or an injection attempt probing the fence.

## 4. The Graph Compiler (L0 → L1)

### 4.1 The end state, stated up front

One prompt in, a runnable workflow out:

> "Study @acmecorp's tweet history. Every night, work through older tweets in batches of 50, turn each into a markdown research note, and keep track of what's been covered so we never re-read a tweet."

From this the compiler produces a draft graph — nodes, event entities with their description prompts, emit/consume bindings, one prompt per node, store schema, schedules, and **proposed** grants — rendered in the declarative editor (U1's Events/Nodes panels and derived map) for review. The user edits conversationally ("also skip retweets", "make the notes PDFs instead"); each edit recompiles a new draft. Save runs the deterministic gate (§5); publish compiles the packet schemas, applies migrations and activates the version. From there the runtime takes over and the §11 script compiler lowers the hot paths to JS without further authoring.

The compiler is an authoring assistant with a checker, not an authority: **it can propose anything and grant nothing** (§4.3).

### 4.2 Compilation passes

The compiler runs as staged passes over one evolving draft. Staging matters less for the LLM (it may be one call or several) than for the *contract*: each pass has a defined output that the gate checks independently.

**P1 — Topology.** Nodes with kinds, the event entities the workflow needs, each node's `emits`/`consumes` bindings, and schedules. There is nothing to draw: topology falls out of the declarations (`event-centric-model.md` §1.3), so P1's output is two lists and their cross-references. The compiler is prompted with the kind taxonomy and constraints (§2.1) and the standard shapes — notably the plan/act/record triangle below, which the canonical example instantiates. Cycles are legal but flagged (Decision #6) and require a loop budget.

**P2 — Node prompts.** One task prompt per node, derived from the intent: what to do, when to emit which event, what *not* to do. These are the L1 artifacts the runtime agents actually execute against, so the compiler writes them the way the tech plan writes policy — behavior in the prompt, enforcement in the runtime.

**P3 — Data declarations.** Two outputs, one pass, because they must cohere:

- **Event descriptions** — one plain-language description per event entity, which the publish-time compiler lowers to a JSON Schema. **This half has shipped** (EC1): the pipeline, its ajv-strict gate, its carry-forward hash and its per-event report all exist, so P3 authors the *description* and inherits the lowering rather than emitting schemas itself.
- **Store schema** — DDL plus a typed *table spec* per table (the ajv-checkable analogue of a packet schema, used by `store.insert`/`upsert` validation).

Compiling them together is what keeps names coherent end to end: the compiler sees that `tweet.detected.tweet_id` feeds `visited.tweet_id` and keeps the field name identical rather than drifting to `id` in one place and `tweet_id` in another. The two halves land at different moments — the store schema is fixed at save, the packet schema at publish — so the coherence P3 writes into the descriptions is checked mechanically at both (§5).

**P4 — Grant proposal.** Least-privilege grants per node, derived from what each prompt actually needs: navigation allowlist from the domains the intent names, capability flags from the actions described, store write grants from the tables each asset node populates, MCP allowlist from tools referenced. Emitted as **proposed**, persisted in a pending state, and surfaced as an explicit review checklist in the editor. Nothing executes until the user approves the grant set — see §4.3.

**P5 — Self-repair loop.** Gate failures (§5) are fed back to the compiler verbatim (like the LaTeX renderer surfacing the TeX log, §13.5), and it retries within a fixed budget (default: 3). Unresolved failures surface to the author with the compile report. The gate never bends; the compiler bends.

### 4.3 The grant boundary

A compiler that can write policy is a policy bypass with extra steps — the exact failure §10's pushback warned about ("a task definition generated by an AI assistant grants itself everything"). Three rules, enforced in the control plane, not the prompt:

1. The compiler's output channel for grants is `proposed_grants` — a distinct artifact that the engine **cannot dispatch against**. Only user-approved grants become `task_grants`.
2. Approval is per-grant-set and shown as a diff on recompile: an edit that silently widens the nav allowlist is exactly what the review UI must make loud.
3. The account baseline (§10, Decision #1) applies to approved grants as always — a user click cannot override "purchases always require approval" any more than the compiler can.

This is the same shape as the rest of the system: LLM authors, deterministic layer gates, human approves the dangerous subset.

## 5. The Deterministic Gate

Runs at save, in full, on every version — not a delta check, because cross-references span the whole graph. All checks are mechanical; no LLM judges another LLM here.

1. **Graph shape.** `graph_json` validates against the graph schema (zod). Node refs unique; event types unique within the version.
2. **Kind constraints.** Schedules bind only to `browser`/`decision`; asset nodes declare at least one `consumes` type; no tool references outside the node's registry in any grant.
3. **Event wiring.** Every `emits` type references a declared event entity — **fail**, because an undeclared emit passes publish and then fails every run at `validatePacket`. Every declared event has a non-empty description. Consumed-but-never-emitted is **advisory**, not a failure: system events (`run.failed`), `manual.trigger` and schedule fires are legitimate external types no entity declares. Emitted-but-unconsumed stays a warning (often intentional). Schema compilation itself is not checked here — it happens at publish, under its own ajv-strict gate, and reports per event (`event-centric-model.md` §3).
4. **Store DDL.** Parses; applies cleanly to a scratch schema (create, then rolled back); every table has a primary key; column types from the allowlist (int/bigint/text/bool/timestamptz/date/numeric/jsonb); no triggers, functions, foreign tables, or cross-schema references; table and column names match the table spec exactly.
5. **Table specs.** Each compiles under ajv; spec fields ↔ DDL columns are bijective; primary key named by the spec exists in the DDL.
6. **Store references.** Every `store_write_grants` table exists in the spec; every decision node's workflow has a store schema if any `store.*` tool would be exposed; warn on tables no task writes.
7. **Migration classification.** Diff against the current version's spec → `none | additive | destructive` (§6.2). Destructive requires the author's explicit confirmation flag on this save; absent flag → fail with the diff shown.
8. **Grant sanity.** Proposed grants reference secrets, MCP tools, and asset paths that exist; no proposed grant conflicts with an account baseline rule (conflict → stripped and reported, not silently kept pending).
9. **Cycles and budgets.** Cycle detection; any cycle requires an explicit loop budget on the workflow (Decision #6 UI warning becomes a gate failure if no budget set).
10. **Coherence lints (advisory).** Field-name mismatches between an event's description and a consumer's prompt (`tweet_id` described, `tweetId` referenced), prompts naming tables that don't exist. Warnings, not failures — prose references are heuristic.

Output: a **compile report** (per-check pass/warn/fail with locations) stored with the version and rendered in the editor. EC1 ships the per-event slice of this already — publish returns `{events: [{type, status, error?}]}` and the editor deep-links each failure into its description — so S8 widens an existing surface rather than inventing one, and adds the `compile_reports` table the transient version does without. The report is to the graph compiler what the trace is to the script compiler: the ground truth an author debugs against.

## 6. Versioning

### 6.1 What pins, what flows

The §5 rule holds and extends: **runs pin the workflow version they started under; new events route against the latest.** A workflow version now snapshots: `graph_json`, tasks (prompts, kinds, limits), event defs with their compiled schemas, the `task_emits`/`task_consumes` bindings, schedules, the store schema artifact, and the approved grant sets. One version, one review, one publish.

The store's *data* is the deliberate exception — it is shared across versions, because it is the workflow's memory. You version the schema and migrate the one store forward; you do not fork data per version.

### 6.2 Store migrations

`store_schemas` rows are immutable per version. At publish, the migrator (the only holder of DDL privilege, §3.3) applies the classified migration:

- **`additive`** (new table, new nullable/defaulted column): auto-generated, applied at publish inside a transaction, safe for in-flight runs pinned to the older version — old readers and old table specs simply don't see the new column. This is the common case and it is zero-friction.
- **`destructive`** (drop table/column, type narrowing, PK change): never automatic. Requires the confirmation flag (§5 check 7), and a publish policy of either **drain** (block publish until in-flight runs finish) or **force** (publish now; in-flight runs that hit the removed structure fail and retry under the new version per §15). Default: drain.

Every applied migration bumps a monotonically increasing `schema_version` recorded on the schema itself (a `wfdata_<id>._meta` row) — this is what compiled decision scripts guard on (§2.4), turning a mid-flight migration into a clean deopt instead of a wrong answer.

### 6.3 Graph versions × compiled scripts

The link the tech plan left implicit, made explicit: L2 artifacts attach to a **task content hash**, not to a workflow version. `content_hash = hash(kind, prompt, limits, approved grants, emitted packet schemas, consumed packet schemas, store tables touched)`.

- Publish a new version where a task's hash is unchanged → its compiled script (and promotion counters) carry forward. Editing one node does not demote the other five to `ai` mode.
- Hash changed → the task's scripts are invalidated (`compile.invalidated` emitted), the task reverts to `ai`, and the §11 promotion loop (K clean consistent traces) rebuilds the fast path against the new definition.

This closes the "how does graph versioning interact with compilation" question: the graph compiler changes *what a task is*; the script compiler is keyed on exactly that, so invalidation is automatic, minimal, and observable.

## 7. The Canonical Example, End to End

Intent (the single L0 prompt from §4.1) compiles to:

```
[cron 02:00 Asia/Karachi]
      │ (empty packet)
      ▼
[decision: plan-batch]  ──browse.request {tweet_url}──►  [browser: read-tweet]
   store.query:                                              │
   candidates NOT IN visited,                                │ tweet.detected
   LIMIT 50                                                  │ {tweet_id, text, url, posted_at}
      ▲                                                      ▼
      │ run.completed (optional backfill loop,      [asset: tweet-to-note]
      │  bounded by loop budget)                       assets.write(/notes/<id>.md)
      └──────────────────────────────────────────      store.upsert(visited, {tweet_id, ...})
```

Store schema (compiled by P3 from "keep track of what's been covered"):

```sql
-- wfdata_<id>
CREATE TABLE visited (
  tweet_id   text PRIMARY KEY,
  url        text NOT NULL,
  note_path  text NOT NULL,          -- the asset it became
  visited_at timestamptz NOT NULL
);
CREATE TABLE candidates (
  tweet_id   text PRIMARY KEY,
  url        text NOT NULL,
  posted_at  timestamptz NOT NULL
);
```

Proposed grants (P4, pending until approved): `read-tweet` gets nav allowlist `x.com`, capabilities click/scroll only; `tweet-to-note` gets `store_write_grants` on `visited` (and `candidates` if the browser task discovers-and-emits rather than a separate discovery pass) plus `asset_write_grants` on `/notes/*`; `plan-batch` gets nothing but its registry — there is nothing to grant a decision node beyond its query budget.

**The ordering rule worth a sentence in every reviewer's head:** `visited` is upserted by the asset node *after* the note is written, in the same transaction as its emit. A crash between browse and note-writing therefore re-plans the tweet (at-least-once) rather than losing it; the resulting duplicate `browse.request` is absorbed by `emitIfNew(dedupeKey: tweet_id)` and the duplicate upsert is idempotent. Do not "fix" the re-planning window by marking visited earlier — that converts at-least-once into at-most-once and loses tweets on crashes.

## 8. Security Analysis (extends tech plan §16)

**Threat 9 — The store as an injection relay.** Web content is written into rows by asset nodes; decision nodes read rows into LLM context; therefore *the store carries prompt injection from the web to the decision node*, one hop removed from any page. This is accepted and contained rather than prevented: the decision node's registry is `store.query` + `emit` — no navigation, no MCP, no secrets, no assets. An injected decision node can emit a malformed or hostile `browse.request`; that packet is schema-validated, and the browser task it triggers is fenced by its own nav allowlist and capability grants, which the injected text cannot alter. Query results are delimited as data in context (§13 discipline). Residual risk — an injected decision node can *mis-plan* (skip items, reorder, emit junk within schema) — is documented honestly, like Threat 2's residual.

**Threat 10 — LLM-authored SQL.** Reads: parse gate (single SELECT) + reader role + `READ ONLY` transaction + pinned `search_path` + timeout + result caps (§3.5). Writes: no raw DML exists — structured `insert`/`upsert` with ajv-validated rows only (§3.4). DDL: no runtime path; publish-time migrator only (§3.3, §6.2). The role pair means a validator escape still reads/writes nothing outside its own workflow schema — in particular, never the platform tables.

**Threat 11 — The graph compiler as a policy author.** A compiler that grants is a bypass. Mitigation is structural: `proposed_grants` is not dispatchable, approval converts it, diffs are shown on every recompile, and the account baseline caps what approval itself can confer (§4.3). The same applies to imported or templated workflows later: they arrive with all grants pending, always.

**Threat 12 — Role/session escape in the store path.** `SET LOCAL ROLE` is only as good as statement isolation. Enforced by protocol (extended query, single statement) ahead of the parse gate, and `SET LOCAL` scopes to the transaction, so even an aborted path resets. Neither workflow role has `LOGIN`, `CREATEROLE`, or any privilege beyond its schema grants.

## 9. Data Model Additions (extends tech plan §14)

```
-- tasks.kind gains 'decision'; tasks gains content_hash (§6.3)

store_schemas(workflow_id, version, description_text, ddl,
              tables_spec_json, migration_sql,
              migration_class[none|additive|destructive], created_at)
store_write_grants(task_id, table_name)

proposed_grants(workflow_version_id, task_ref, grant_json,
                status[pending|approved|rejected|stripped_by_baseline])
compile_reports(workflow_version_id, report_json, created_at)

-- runtime objects per workflow (not rows — created by the migrator):
--   schema wfdata_<workflow_id>            (+ _meta row carrying schema_version)
--   roles  wfd_<workflow_id>_r  (NOLOGIN, SELECT)
--          wfd_<workflow_id>_w  (NOLOGIN, SELECT/INSERT/UPDATE/DELETE)
```

## 10. Build Plan Placement

Fits the existing roadmap after the asset store lands, reusing its two key patterns (path/table write grants; packet-schema compile pipeline):

- **S5g — workflow store + decision kind:** `wfdata` schema/role provisioning, migrator, `store.*` tools with parse gate and role fencing, `kind=decision` registry + trigger constraints, table-spec ajv validation. The canonical example's plan/act/record triangle as the e2e test.
- **S8 (new) — graph compiler:** passes P1–P5, deterministic gate, compile reports, proposed-grants flow in the control plane, conversational recompile in the editor. Depends on S2c (API) and S7 (real policy evaluator, so approved grants mean something). P3's packet-schema half and the per-event report are **already built** (EC1) — S8 reuses `SchemaGenerator` and the publish path rather than adding a second lowering.
- Decision-node L2 compilation (`ctx.store` in the static runtime, `guard.storeSchema`) is post-S6c, deliberately unscheduled (§2.4).

## 11. Decisions and Open Questions

Resolved in this document:

1. **Third node kind `decision`** — read-only store + emit; schedule- and event-triggered; smallest registry in the system.
2. **Store = Postgres schema per workflow, same database** — outbox atomicity is the deciding argument; SQLite/NoSQL/database-per-graph rejected (§3.2).
3. **Role pair per workflow, no per-graph databases** — DB-level fence behind the tool-layer gate; DDL confined to the publish-time migrator.
4. **Writes structured + ajv-validated; reads raw SELECT, fenced** (§3.4–3.5). `store.delete` deferred.
5. **Store schema compiled from a prompt** — same shape as the packet-schema pipeline (Decision #2), authored in one pass with the event descriptions so names cohere. The two land at different moments: store schema at save, because §5's DDL checks and migration classification need it; packet schemas at publish, per EC1.
6. **Migrations: additive auto, destructive gated** (drain by default); `schema_version` guard for future compiled decisions.
7. **Compiled scripts key on task content hash** — graph edits invalidate exactly the tasks they change.
8. **The compiler proposes grants, never applies them** — approval + baseline remain the only path to `task_grants`.

Open:

1. **Candidate discovery** in the canonical example: does the browser task populate `candidates` via an asset node on first run (discovery pass), or does the decision node emit paging requests (`browse.request {profile_url, cursor}`) and let the browser discover incrementally? Both fit the model; the compiler should prefer the incremental shape (no unbounded first run).
2. **Store quotas** — rows/bytes per workflow schema; belongs with the trace-retention/asset-quota open question (tech plan §18 open #3).
3. **Result-cap ergonomics** — fixed N rows vs token-budgeted truncation for `store.query` results in decision context.
4. **Cross-workflow reads** — assets are readable across workflows (§13.5); the store is deliberately not, in v1. A read-only "publish this table" export between workflows may be wanted later; if so it should be an explicit grant, not a default.
5. **One-prompt compilation UX depth** — how much of P1–P4 runs on every keystroke-level edit vs on explicit "recompile"; cost and latency of the compiler loop.
