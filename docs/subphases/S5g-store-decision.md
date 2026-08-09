# S5g — Workflow data store + `kind=decision`

You are implementing subphase S5g. Read, in order:
1. This file (authoritative).
2. `docs/graph-compilation-llm.md` — §2 (decision kind), §3 (store placement, roles, tools),
   §6.2 (migrations), §7 (canonical triangle + ordering rule), §9 (data model). This is the
   primary design source for this subphase.
3. `docs/impl-phases.md` — §0.5 (telemetry rules), Phase 5 context.
4. `docs/subphases/ROADMAP.md` — stack/style rules.

Existing code to reuse (read first, match style): `packages/db` (Drizzle schema + migrator),
`packages/bus` (outbox — store writes MUST share its transaction), `packages/engine`
(executor registry keyed on `(kind, mode)` from S5a; packet validation — the ajv machinery
you will reuse for rows), `packages/agent` (S4 agent loop + replay adapter — DecisionExecutor
composes it), `packages/telemetry` (injected meter, SOb), `apps/testkit` (test DBs, fixtures).

## Scope

The per-workflow data store (Postgres schema + role pair) with `store.*` tools, and the third
task kind `decision`. **NOT in scope:** LLM compilation of store schemas from free text (S8 —
you receive an already-compiled artifact via the API), the store browser / query console UI
(U3.5), compiled decision scripts (post-S6c), `store.delete`, cross-workflow store reads,
and export-to-SQLite. The store schema artifact arrives as data; nothing in this subphase
calls an LLM except the DecisionExecutor's replayed agent loop.

## Deliverables

1. **`packages/store`** — provisioning and the migrator (the sole DDL holder):
   - `provision(workflowId)`: create schema `wfdata_<workflow_id>` **in the same database**
     (outbox atomicity — never a second DB), NOLOGIN roles `wfd_<id>_r` (SELECT) and
     `wfd_<id>_w` (SELECT/INSERT/UPDATE/DELETE), schema-scoped `GRANT`s plus
     `ALTER DEFAULT PRIVILEGES` so migration-added tables stay granted; a `_meta` row holding
     a monotonically increasing `schema_version`. `deprovision(workflowId)`: `DROP OWNED` /
     `DROP ROLE` / `DROP SCHEMA ... CASCADE`.
   - **Schema artifact validation** (deterministic; mirrors what S8's gate will call): DDL
     parses and applies cleanly to a scratch schema (rolled back); every table has a PK;
     column types from the allowlist (int/bigint/text/bool/timestamptz/date/numeric/jsonb);
     no triggers, functions, foreign tables, or cross-schema references; DDL columns ↔
     `tables_spec_json` fields bijective.
   - **Migration classifier + applier** (§6.2): diff new spec vs current →
     `none|additive|destructive`. Additive → auto-generated SQL, applied at publish in one
     transaction, `schema_version` bumped. Destructive → rejected unless the publish call
     carries an explicit confirmation flag; response includes the diff.
2. **Platform tables** (Drizzle migration, per graph-compilation-llm §9): `store_schemas`
   (workflow_id, version, description_text, ddl, tables_spec_json, migration_sql,
   migration_class, created_at) and `store_write_grants(task_id, table_name)`. Wire
   `publishVersion` (S2c API) to accept the artifact, run validation + classification, and
   apply on publish.
3. **`store.*` tools** (registered per kind — asset gets all three, decision gets `query` only):
   - `store.query(sql)`: layered read fence, all layers mandatory — (a) parse gate via a real
     SQL parser (`pgsql-ast-parser`; justify any alternative): exactly one statement, statement
     type SELECT, CTEs allowed, `SELECT ... INTO` and locking clauses rejected; (b) execute
     under `SET LOCAL ROLE wfd_<id>_r`, `READ ONLY` transaction, `SET LOCAL search_path =
     wfdata_<id>, pg_catalog`, `statement_timeout`; extended query protocol only (parameterized
     single statement — multi-statement unrepresentable); (c) row cap: fetch N+1, truncate with
     a count notice in the tool result. Results returned delimited as data.
   - `store.insert(table, row)` / `store.upsert(table, row)`: row validated with **ajv against
     `tables_spec_json`** (reuse the packet-validation machinery — do not write a second
     validator); write-grant check against `store_write_grants`; executes under the writer role
     **inside the run's outbox transaction** so a store write + `emit` commit atomically;
     upsert conflict target = the table's declared PK.
4. **`kind='decision'`**: extend the S5a check constraint to `browser|asset|decision`; registry
   is `store.query` + `emit` and NOTHING else (assert like the S5c registry-isolation test);
   schedules may bind to `browser|decision`, never `asset` — update the S2c write-time
   validation and the DB constraint; `DecisionExecutor` = the S4 agent loop with the decision
   registry, trigger-packet fields injected as for any consumer. Asset registry gains
   `store.query/insert/upsert`.
5. **Telemetry** (§0.5 binding names): `store_query_duration_seconds`,
   `store_sql_rejected_total{reason}` via the injected meter.
6. **System tests** (`tests/system/`, content-named):
   - **Role fence (defense in depth):** bypass the parse gate via a test hook and run a SELECT
     against another workflow's `wfdata_*` schema and against a platform table (`runs`) — both
     fail at the DB layer with a permission error.
   - Parse-gate corpus (table-driven, extend-on-new-idea): `SELECT 1; SELECT 2`, `UPDATE`,
     `DELETE`, `SELECT ... INTO`, `FOR UPDATE` → typed rejection each, and
     `store_sql_rejected_total` incremented with the right `reason` (assert via the injected
     fake meter — this is a security counter, the one sanctioned telemetry assertion).
   - `store.insert` with a row violating the spec → tool error, no row written. Write outside
     `store_write_grants` → denied.
   - Additive migration: publish v2 adding a nullable column → auto-applied, `schema_version`
     bumped, an in-flight run pinned to v1 still reads. Destructive without the confirmation
     flag → rejected with diff; with the flag → applied.
   - **Plan/act/record triangle e2e** (replay transcripts): cron → decision node queries
     `visited`, emits `browse.request` for unvisited only → browser node emits
     `tweet.detected` → asset node writes the doc and upserts `visited` **in one transaction
     with its emit**. Crash-inject between the store write and commit → after restart, neither
     row nor event exists; the retried run completes both. Re-fire the cron → decision node
     emits nothing new (mark-visited-after-write + `emitIfNew` per graph-compilation-llm §7).

## Style constraints (binding)
- The migrator is the only code path that issues DDL against `wfdata_*`; grep-able invariant.
- No ORM inside `wfdata_*` schemas — LLM-defined tables are accessed via the fenced SQL path
  only; Drizzle models the platform tables, never workflow tables.
- New deps: `pgsql-ast-parser` only. Role/schema names are derived, never interpolated from
  user input.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior suites stay green, including the S5c registry-isolation test extended for the
decision kind. Run the triangle e2e twice — second run must be a no-op (dedupe + visited).

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Do NOT git commit.
