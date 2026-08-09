# S8 — Graph compiler: one prompt → checked, versioned graph

You are implementing subphase S8. Read, in order:
1. This file (authoritative).
2. `docs/graph-compilation-llm.md` — the primary design source: §4 (passes P1–P5, grant boundary),
   §5 (deterministic gate), §6 (versioning, content hash, migrations), §7 (canonical example —
   your flagship fixture), §9 (data model additions).
3. `docs/techical_plan.md` — §18 Decision 2 (the packet-schema pipeline P3 generalizes),
   §11 (the script registry your content hash invalidates into).
4. `docs/impl-phases.md` — UI track U6 (the consumer of your API — you build the API only).
5. `docs/subphases/ROADMAP.md` — stack/style rules.

Existing code to reuse (read first): `apps/web` + `packages/db` (S2c's `publishVersion` path —
the compiler and gate bolt onto it, they do not replace it), the S4a **LLM adapter** in
`packages/agent` (live/record/replay — do NOT build a second adapter), S5g's store migrator and
scratch-schema DDL machinery, `packages/compiler`'s script registry (S6 — the invalidation target).

## Scope

The save-time LLM pass that turns a plain-language intent (or a conversational delta) into a
draft graph, the deterministic gate that checks every version, the proposed-grants flow, and
content-hash script invalidation. **API only** — the U6 editor UI is NOT in scope. The gate
contains NO LLM calls; the compiler performs NO enforcement (it proposes; approval + baseline
dispose). The invariant to preserve verbatim: *the compiler can propose anything and grant nothing.*

## Deliverables

1. **`packages/graph-compiler`** — the passes (§4.2), each with a defined output the gate checks
   independently:
   - **P1 topology**: nodes with kinds, edges with event-type bindings, schedules. Prompted with
     the kind taxonomy/constraints and standard shapes, including the plan/act/record triangle.
   - **P2 node prompts**: one task prompt per node derived from the intent.
   - **P3 data declarations**: packet schemas AND store schema (DDL + ajv table specs) compiled
     in ONE pass, so field names cohere across edges and tables (`tweet_id` stays `tweet_id`).
   - **P4 grant proposal**: least-privilege grants derived from the intent; the ONLY output
     channel is `proposed_grants` rows — never `task_grants`.
   - **P5 self-repair**: gate failures fed back to the compiler VERBATIM (like the S5e TeX log),
     retry budget default 3; unresolved failures surface in the compile report, never bend the gate.
   - Uses the S4a adapter; every compile must be recordable and replayable.
2. **Deterministic gate** — runs at save, on the WHOLE graph (cross-references span it), all
   checks mechanical. Implement all ten as named checks, each emitting pass/warn/fail + location
   into the report:
   1. **graph shape** — zod-valid `graph_json`; unique node refs; edges reference existing nodes.
   2. **kind constraints** — schedules bind to `browser`/`decision` only; asset nodes have ≥1
      inbound edge; no tool references outside the node's registry in any grant.
   3. **event wiring** — every edge's event type declared by its source's `event_defs`; packet
      schemas compile under ajv strict; WARN emitted-but-unconsumed, FAIL consumed-but-never-emitted.
   4. **store DDL** — parses; applies cleanly to a scratch schema (then rolled back); every table
      has a PK; column types from the allowlist (int/bigint/text/bool/timestamptz/date/numeric/jsonb);
      no triggers, functions, foreign tables, or cross-schema references; names match the spec.
   5. **table specs** — each compiles under ajv; spec fields ↔ DDL columns bijective; declared PK exists.
   6. **store references** — every write-grant table exists in the spec; a decision node implies a
      store schema exists; WARN on tables no task writes.
   7. **migration classification** — diff vs current version → `none|additive|destructive`;
      destructive without the author's confirmation flag → FAIL with the diff shown.
   8. **grant sanity** — proposed grants reference secrets/MCP tools/asset paths that exist;
      baseline conflicts → stripped + reported (status `stripped_by_baseline`), never silently kept.
   9. **cycles and budgets** — cycle detection; any cycle without a workflow loop budget → FAIL.
   10. **coherence lints (advisory)** — field-name drift across an edge, prompts naming absent
       tables — WARN only.
3. **Data model** (§9, Drizzle migrations): `proposed_grants(workflow_version_id, task_ref,
   grant_json, status[pending|approved|rejected|stripped_by_baseline])`,
   `compile_reports(workflow_version_id, report_json, created_at)`, `tasks.content_hash`;
   `store_schemas` columns if S5g left gaps (`migration_sql`, `migration_class`).
4. **Grant boundary**: the engine dispatches against `task_grants` ONLY. A tRPC approval
   endpoint converts `pending` proposals to `task_grants`; recompiles compute and store the diff
   against the prior version's proposals (U6 renders it). Baseline rules cap approved grants too.
5. **Content hash + invalidation** (§6.3): `content_hash = hash(kind, prompt, limits, approved
   grants, consumed + emitted packet schemas, store tables touched)`. On publish: hash unchanged →
   compiled scripts and promotion counters carry forward; changed → scripts `invalidated`,
   `compile.invalidated` emitted, task reverts to `ai` mode.
6. **Publish integration**: gate pass (warnings allowed) is a precondition for activating a
   version; additive store migrations auto-apply through the S5g migrator at publish;
   destructive requires the confirmation flag + drain-or-force policy (default **drain**).
7. **tRPC surface for U6**: `graph.compile(intent | delta)`, `graph.getReport(versionId)`,
   `graph.approveGrants(versionId, decisions)`. Thin routers; logic in the package (S2c rule).
8. **System tests** (`tests/system/`, replay transcripts checked in):
   - **Canonical one-prompt compile**: the §4.1 tweet-study intent → the §7 triangle (decision
     `plan-batch`, browser `read-tweet`, asset `tweet-to-note`), cron on the decision node,
     `visited`/`candidates` DDL passing the gate, proposed grants matching §7 (nav `x.com` +
     click/scroll; store write on `visited`; asset write `/notes/*`; decision node: registry only).
   - **Gate corpus**: ten failing fixtures, one per check, each asserting the right report entry
     (check name, fail vs warn, location).
   - **Self-repair**: transcript where the compiler emits invalid DDL, receives the gate failure
     verbatim, corrects on retry 2; plus a budget-exhaustion fixture surfacing the unresolved report.
   - **Grant boundary**: publish with proposals unapproved → dispatched tasks have empty
     `task_grants` (assert the rows; under an S7 gate this means denials, not grants);
     baseline-conflicting proposal → `stripped_by_baseline` + report entry.
   - **Content hash**: republish with ONE node's prompt changed → only that task's compiled
     script invalidated + `compile.invalidated`; the untouched sibling's script and counters survive.
   - **Destructive migration** without the confirmation flag → publish rejected, diff in the report.

## Style constraints (binding)
- `packages/graph-compiler` is framework-agnostic; do not confuse it with `packages/compiler`
  (the trace→JS script compiler) — no shared code beyond `packages/core` types.
- The gate is pure and deterministic: no LLM, no clock, no network beyond the scratch-schema
  Postgres connection. Gate and compiler are separately importable (tests hit the gate directly).
- P1–P5 prompt templates live as versioned files in the package, not inline strings.
- New deps: a SQL parser for check 4 if needed (justify the choice); nothing else expected.

## Verification
```
pnpm install && pnpm build && pnpm test && pnpm --filter web lint
```
All prior tests stay green. Run one record-mode compile against the live adapter and note the
outcome in the report (not in CI).

## Report back
What you built, deviations + why, commands + outcomes, where the compiler needed retries (prompt
template quality signal), flakiness noticed. Do NOT git commit.
