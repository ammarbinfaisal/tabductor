# The Event-Centric Model — events as entities, prompts as the only authoring surface

**Version:** 1.1
**Status:** Implemented (EC1, 2026-08-10). This is the wiring model of record. It replaced the
edge-based model, and `techical_plan.md` (0.6) and `graph-compilation-llm.md` (0.2) are now
written against it — this document carries the routing, publish-compiler and editor detail
behind their summaries rather than sitting as an amendment over them.

---

## 1. The decision

Three statements, made together, that reshape both the backend and the editor:

1. **The event is an entity of the graph, not a property of its emitter.** One row per
   `(workflow version, type)` — `event_defs(id, workflow_version_id, event_type,
   description, packet_schema_json, prompt_hash, public)` — whoever emits it. The old
   model let two emitters of `tweet.detected` declare two different schemas for the same
   type; the entity model makes that unrepresentable.

2. **The client never sends JSON.** Not a packet schema, not a stub script. The author
   writes a *description* of the packet in plain language; the schema is compiled from it
   at publish time by an LLM whose context is the whole neighbourhood of the event — the
   prompts of every task that emits it and every task that consumes it. The compiled
   schema is displayed read-only and cannot be round-tripped.

3. **Topology is derived, not drawn.** A task declares `consumes` (the event types that
   trigger it, alongside an optional schedule) and `emits` (the types it may produce).
   There is no edges table and no edge in the document; "the graph" is the bipartite
   structure *nodes ↔ events*, materialized only for display. The thing the author edits
   is a set of declarations, which is why the editor is panels over a canvas (see §6).

## 2. What routing means now

`dispatchEvent` resolves subscribers by **type alone** within the workflow's latest
version: one index probe on `task_consumes(workflow_version_id, event_type)` — the exact
successor of the dropped `edges_routing_idx`. The emitter matters only for resolving
*which workflow* an event belongs to (`source_task_id`, as before).

Consequences, all deliberate:

- An event of type T reaches **every** consumer of T, whichever task emitted it. Two
  branches that reuse a type name are now coupled — that is what sharing a type *means*
  in this model. A future lint can warn on multi-emitter types; v1 accepts them (and
  tests assert the fan-out on purpose).
- A task that consumes a type it also emits self-triggers. Legal cycle; the
  causation-chain loop budget (`max_hops`) and the `(task, event)` dedupe claim bound it
  exactly as they bounded edge cycles. Nothing in that machinery changed.
- The old "entry edge" carve-out dissolves. Consumes may reference types no event entity
  declares — system events (`run.failed`), `manual.trigger`, schedule fires — because
  demanding a declaration would force authors to describe packets this graph never
  produces. Emits, by contrast, **must** reference declared events: an undeclared emit
  would sail past publish and fail every run at `validatePacket`, so `checkGraph` rejects
  it at save.

## 3. The publish-time schema compiler

This is `graph-compilation-llm.md` §4's P3 pass, shipped in minimal form ahead of the
rest of the graph compiler, with §4.2's staging contract honoured where it applies:

- **Interface, not import:** `publishVersion(db, input, { schemaGenerator })`. The engine
  defines `SchemaGenerator`; the model-backed implementation (bounded 3-attempt self-repair
  per §4 P5 — the gate's verdict fed back verbatim) lives behind the `@tabductor/engine/ai`
  subpath and is constructed only at composition roots that hold a key. Publish runs in the
  web process today, so that root is the tRPC context; tests and `seedWorkflow` inject a
  deterministic generator and still exercise the one true publish path.
- **One compiler, two providers.** The prompt, the gate and the repair loop live in
  `schema-generator-llm.ts` behind a `ChatTransport` seam that is ours rather than an SDK's;
  `schema-generator-ai.ts` fills that seam through the Vercel AI SDK, so a provider is a
  config line. Selection is by key — `ANTHROPIC_API_KEY` (default `claude-opus-5`) first,
  then `OPENAI_API_KEY` (default `gpt-5.2`), with `SCHEMA_MODEL` overriding the model id.
  Anthropic wins when both are set because the instructions were written and checked against
  Claude. The seam is what keeps that a transport choice: the gating and the attempt budget
  are one tested implementation neither provider can vary
  (`packages/engine/src/schema-generator-llm.test.ts`).
- **The deterministic gate:** every schema — generated or carried — must compile under
  ajv **strict** (+ formats) before a row is written. The generator's instructed
  allowlist (flat-ish objects, string/number/integer/boolean, string formats, enums,
  arrays, one level of nesting) is exactly the subset the stub sampler can synthesize
  packets for (§5). LLM authors; deterministic layer gates — §2 of the compiler doc,
  unchanged.
- **Stability — the carry-forward hash.** `prompt_hash = sha256(description + sorted
  emitter prompts + sorted consumer prompts)`. A publish whose hash matches the previous
  version's carries that schema forward byte-identical with **zero** generator calls, so
  the steady state (tweak a timeout, edit a stub) is free and schemas do not drift under
  republish. Only changed events pay, at bounded concurrency.
- **The compile report.** Publish returns `{events: [{type, status:
  generated|reused|failed, error?}]}` per event and never stops at the first failure. Any
  failure fails the whole publish *atomically* — no rows, current version unmoved — with
  the report riding out on `graph_compile_failed` for the editor to mark every offending
  event. This report is the seed of §5's compile-report artifact; a persisted
  `compile_reports` table is deferred until the full compiler lands (S8).

Editing a task's `prompt` via `task.update` changes generator *context* without a
republish; the affected events recompile on the next publish, not immediately. Schemas
only ever change at publish.

## 4. Sharing follows the entity

`public` re-homes from per-(task, type) declarations to the event entity — which is the
semantics enforcement always had (`publicEventTypes` unioned per type; the migration
collapses with `bool_or`, so no viewer sees more than before). The public graph now
carries an `events` list (type, visibility, schema-if-public — never the description,
which is authored content) plus per-task `emits`/`consumes` as bare type lists, and
derives `edges` for rendering. The share preview lists events with their emitters instead
of emitters with their events. The never-widen rule — visibility filtered in SQL, packet
column selected conditionally — is untouched.

## 5. Stub derivation

With schemas known at publish, a stub task needs no script: absent `limits_json.stub`,
the StubExecutor emits **one valid sampled packet per declared event**, synthesized
deterministically from the compiled schema (`sampleFromSchema`, whose supported shapes are
the generator's allowlist). A present script still fully specifies behavior — the
`fail`/`fail_times`/`hang_ms` knobs the engine tests script against are unchanged — and a
task with neither script nor declared emits stays a no-op. A graph is therefore
exercisable the moment it publishes, with nothing hand-written.

## 6. The editor consequence

Since the authored artifact is declarations, the editor stops being a canvas. The U1
redesign (design track: `JOURNEY.md` → a locked `DESIGN.md`, "Ruled Ink") replaced React
Flow with three panels — **Events** (cards: type, description prompt, visibility, read-only compiled
schema), **Nodes** (cards: kind, prompt, trigger chips = schedule/consumes, emit chips) —
and a **derived map**: an auto-laid-out, read-only rendering of the bipartite topology
(dependency-free SVG; cycles annotated with the loop-budget note). Wiring is toggling a
type on a node, never drawing a line. Publish renders the compile report per event;
the visibility-diff confirmation survives, reading `graph.events`.

## 7. Data-model delta (against `techical_plan.md` §14)

```
event_defs(id, workflow_version_id → workflow_versions, event_type,
           description, packet_schema_json, prompt_hash, public)
           unique (workflow_version_id, event_type)          -- re-keyed from (task, type)
task_emits(task_id → tasks, workflow_version_id → workflow_versions, event_type)
           pk (task_id, event_type)
task_consumes(task_id → tasks, workflow_version_id → workflow_versions, event_type)
           pk (task_id, event_type); index (workflow_version_id, event_type)  -- routing
-- edges: dropped (migration 0007 backfills task_consumes from it first)
```

The graph document: `{tasks: [{name, kind, mode, prompt, limits, emits: string[],
consumes: string[], schedule, position}], events: [{type, description, public}]}`.

## 8. Interaction with the graph compiler (S8)

Nothing here blocks it; most of it becomes simpler. P1's output is now "nodes + events +
bindings" rather than "nodes + edges"; §5's gate check 3 splits into "every emit is
declared" (fail — implemented) and "consumed-but-never-emitted" (advisory — external
events are legitimate); the P3 pipeline *is* this compiler, extended with the store
schema; the content-hash idea generalizes into §6.3's task content hash. Decision-node
`consumes` and schedule triggers drop out of the trigger model for free.
