# S6a — Static runtime sandbox + script registry + lint gate

You are implementing subphase S6a. Read, in order:
1. This file (authoritative).
2. `docs/techical_plan.md` — §2 principle 3 ("the compiled fast path and the AI slow path go
   through the same door"), §4 (the `(kind, mode)` registry rule and why kinds are a security
   boundary — the compiled path mirrors the browser node's registry exactly), §11 (the
   compiler contract and the script template in full — you build the host that template runs
   on, not the compiler that writes it), §12 (the whole `ctx` contract — normative for this
   subphase), §13.5 (`page.upload`/asset refs, for the one ctx method that depends on S5f),
   §16 Threat 3, §17.2 (metric names + the binding-name discipline).
3. `docs/impl-phases.md` — Phase 6 intro and **build-order items 1–2 only** (static runtime
   host; script registry + lint gate), plus their system-test bullets (the sandbox
   hostile-corpus table is yours); §0.5 (instrument what you build).
4. `docs/subphases/ROADMAP.md` — the node-kind/registry-boundary block (binding from S5a on),
   the `(kind, mode)` tool-registry rule, general style rules.
5. `docs/subphases/S6b-trace-compiler.md` and `docs/subphases/S6c-compiled-executor.md` —
   read both in full before writing a line of code. Neither is yours to build, but both name
   `packages/static-rt` and `packages/compiler` as already existing, with a specific shape
   they depend on (dry-run execution, `compiled_scripts` rows, the lint gate as a callable).
   Those names and shapes are **binding on you** — you are laying track two later trains run
   on without ever seeing them again.
6. `docs/subphases/S5h-python-compute.md` — the sandbox-fallback doctrine ("says so loudly",
   `PYRUNNER_ALLOW_UNSAFE_BACKEND`) your `isolated-vm` decision follows the same shape as.
7. `docs/subphases/S3b-pool-network-limits.md` — general shape of a subphase this size, and
   the `RunSession`/`PolicyGate` injection pattern you are reusing, not reinventing.

## Scope

**The cage and the shelf. Nothing that runs on either yet.** This subphase builds (a) the
isolate a compiled script executes in, with `ctx` as its only window on the world, and (b)
the table that holds script versions plus the gate that keeps bad code off it. It does not
build anything that produces a script or decides to run one.

Existing code to reuse (read first, match style): `packages/browser` (`RunSession` — `ctx`
binds to one; `resolveAnchor`; the session's `page`/`network` API, all already gated through
`PolicyGate` internally — see below), `packages/agent/src/executor.ts` (`makeEmitFn`'s
`task_state`-backed dedupe-claim shape — `ctx.emitIfNew` needs the identical semantics;
whether to share the implementation or duplicate the shape is flagged below), `packages/db`
(schema/migration conventions, the existing `taskState` table `ctx.state` reuses directly),
`packages/policy` (`PolicyGate`, `TaskCtx` — injected, never constructed here), `packages/
telemetry` (`Metrics` type + `createMetrics`, the pattern every metric addition follows),
`tests/system/` conventions (content-named files, real fixture sites, template-clone test DB).

**NOT yours:**
- No trace consistency checker, no compiler agent — that is the entire content of S6b. This
  subphase never reads a `trace_entries` row.
- No `CompiledExecutor`, no deopt handoff into `AgentExecutor`, no promotion/demotion counters,
  no script *activation* logic beyond a registry function S6c calls — that is S6c. You may
  write `activateScript`/`invalidateScript` as registry primitives (S6c's promotion/demotion
  needs somewhere to call), but nothing here decides *when* to call them.
- No engine or composition-root wiring. `packages/static-rt` and `packages/compiler` are
  libraries with no consumer inside `apps/` yet — S6c is what registers a `CompiledExecutor`
  in `apps/engine`. Do not touch `apps/engine`.
- No change to `PolicyGate` itself, no new verdict type. `ctx` reuses the gate that already
  exists.
- `tasks.kind`/`tasks.mode` and `tasks_kind_mode_check` are S5a's; assume they exist (a
  `compiled` task is a `kind='browser'` task, per the constraint S5a already asserts) and do
  not re-derive that rule here.

Since a script executes *inside* the sandbox in every later subphase's tests but is never
compiler-generated in this one, **a hand-written fixture script — plain JS matching §11's
template shape, checked into `tests/system/fixtures/`** — is what exercises the host. It plays
the role S6b's compiler agent plays later: nothing here depends on an LLM.

## Deliverables

New packages: `packages/static-rt` (the isolate host) and `packages/compiler` (the script
registry + lint gate — S6b extends this same package with the consistency checker and
compiler agent; do not name it anything else). Standard workspace boilerplate for both
(`package.json`, `tsconfig.json`, `src/index.ts`, a `tsconfig.json` `paths` entry each in the
root `tsconfig.json`) — no more scaffolding than every existing package already carries.

### 1. Static runtime host (`packages/static-rt`)

**The dependency.** `isolated-vm` is a new production dependency with a native build step —
the first one this repo has taken on for JS execution. Before wiring anything:
- Pin an exact version and verify `pnpm install` builds it clean in this environment (Node 24,
  per the workspace's `@types/node` range) — prebuilt binary or a working `node-gyp` source
  build, either is fine, but confirm which happened and record it.
- Do **not** reach for `vm2` (unmaintained, documented sandbox escapes) or a bare
  `worker_threads` module as a substitute if the native build gives you trouble — neither is a
  security boundary, and §12 says so explicitly for `vm`. If `isolated-vm` truly cannot be
  made to build here, that is a stop-and-report finding, not a silent swap. If you must ship a
  fallback to make forward progress, it follows S5h's `pyrunner` doctrine exactly: label it
  not-a-boundary in its own docstring and in a startup log line, refuse to construct without
  an explicit `STATIC_RT_ALLOW_UNSAFE_BACKEND=1`, and make the hostile-corpus suite (below)
  **skip loudly** rather than run against it — never silently, and never proof the sandbox
  suite tests nothing.

**The entry point.** One function, the thing S6b's dry-run and S6c's executor both call:

```ts
type ScriptRunResult =
  | { outcome: "completed" }
  | { outcome: "deopt"; prompt: string; evidence: unknown }
  | { outcome: "killed"; reason: "wall_clock" | "memory" }
  | { outcome: "error"; error: string };

runCompiledScript(source: string, ctx: CtxHost, opts?: { wallClockMs?: number; memoryMb?: number })
  : Promise<ScriptRunResult>
```

The source is expected to be `export default async function run(ctx) { ... }` (§11's
template, verbatim). `ctx.deopt(prompt, evidence)` does not throw and does not reject the
isolate call: calling it records the prompt/evidence host-side and flips a "deopt requested"
flag; when the guest function's promise settles, the host checks that flag *before* looking
at how the function returned, and reports `{outcome: "deopt", ...}` — this is what lets S6b's
dry-run treat a guard failure as clean (not a pipeline failure) and what S6c's executor
switches on to hand off to `AgentExecutor` without failing the run. A thrown/rejected guest
function that never called `ctx.deopt` is `{outcome: "error"}` — a pipeline failure for S6b,
a bug for S6c. `killed` is the wall-clock/memory cap firing (`isolated-vm` surfaces both
natively: `memoryLimit` at isolate construction, `timeout` on the run call) — distinguish the
two by the error shape `isolated-vm` gives you; do not lump them into `error`.

**Caps have no "absent = unlimited."** Unlike `limits_json.browser` (§8, where an absent
field means no cap), `isolated-vm` requires a finite `memoryLimit` at isolate construction and
a run with no timeout defeats the entire point of the cap — so `wallClockMs`/`memoryMb` always
apply, with sane defaults (propose 10s / 64MB — short guarded scripts, not agent-length runs)
that a task's `limits_json.static_rt.{max_wall_ms,max_memory_mb}` may only tighten, never
remove. State this default explicitly in code, it is not discoverable from §8's convention.

**The `ctx` surface — exactly §12's list, no more:**

| `ctx.*` | Binds to |
|---|---|
| `page.goto/click/type/scroll/waitFor` | `RunSession.page.*` verbatim — the crossing *is* the reuse: these already run through `PolicyGate` inside `openRunSession`'s `act()` wrapper (S3a/S3b), so you are not adding a second gate layer, you are the isolate boundary that makes the existing one reachable from generated code. |
| `page.query(selector)` | `RunSession.page.queryAll(selector, {})` — existence/count, no fields. |
| `page.evalExtract(selector, fields)` | `RunSession.page.queryAll(selector, fields)` — same declarative `ExtractSpec`, still no arbitrary page JS (§12 is explicit that this stays excluded in v1). |
| `page.screenshot` | `RunSession.page.screenshot` |
| `page.upload(anchor, assetRef)` | **Depends on S5f**, which lands before this subphase in build order (ROADMAP), so the primitive should exist on `Page`/`RunSession` by the time you write this. Bind to it the same way as every other `ctx.page.*` method — one crossing, one gate. If S5f's upload primitive is not yet present when you reach this, stub the `ctx.page.upload` *type* now, leave the host implementation throwing `not_implemented`, and say so plainly in the report — do not invent a shape S5f didn't ship. |
| `guard.url/exists/text/noDialog/all/failures` | New — see below. |
| `network.list/read` | `RunSession.network.list/read` verbatim — `read` is already per-part `PolicyGate`-gated inside the session; `list` is intentionally ungated, matching the session's own comment on why. |
| `emit(type, packet)` / `emitIfNew(type, packet, {dedupeKey})` | One injected `EmitFn`-shaped function (same shape as `@tabductor/agent`'s), called with `dedupeKey: undefined` vs. set — **not two code paths**, exactly how the agent's single `emit` tool already works (`packages/agent/src/tools.ts`). `static-rt` must not depend on `@tabductor/agent` (layering — both are consumed by executors, neither by the other), so declare a small local structurally-identical type rather than importing one. **Flag, do not resolve:** the dedupe-claim logic itself (`task_state` insert-with-`onConflictDoNothing`, `emit:${type}:${dedupeKey}` key) lives today as a private closure inside `packages/agent/src/executor.ts`'s `makeEmitFn`. When S6c wires a real `EmitFn` into `ctx`, it should reuse that exact claim logic rather than re-derive it — note in your report that exporting `makeEmitFn` (or relocating the claim helper somewhere both packages import) is the right move for S6c to make, rather than doing the extraction yourself for a caller that doesn't exist yet. |
| `state.get(key)` / `state.set(key, value)` | Direct `task_state` CRUD (`packages/db`'s `taskState` table) — the same table `ctx.emitIfNew`'s dedupe rides on, keyed by `taskId` (from the injected `TaskCtx`), `set` is an upsert. |
| `deopt(prompt, evidence)` | Host-side signal described above — not a browser action, not policy-gated, no trace entry of its own beyond what the caller (S6c, later) chooses to record. |

Not present, deliberately, because §12 does not list them: no `ctx.mcp`, no `ctx.assets.write`
or `.append`, no `page.evaluate`/arbitrary JS, no `page.download`. This is the §4 boundary —
add a system test that enumerates the `ctx` surface (mirrors S5c's registry-isolation test)
and asserts none of these names appear anywhere in it, nested or not.

**Guard implementations, and a gap you have to close.** `ctx.guard.url(pattern)` tests
`RunSession.page.url()`; `ctx.guard.exists(selector, opts)` is `page.waitFor(selector,
opts).then(() => true, () => false)`; `ctx.guard.text(selector, matcher)` reads the first
match via `queryAll(selector, { value: {} })` and tests its text. `ctx.guard.all(checks)`
takes an array of the unawaited promises those return (§11's template builds exactly such an
array and passes it in without awaiting each one first), resolves them all, records a
failure detail per rejected/`false` entry, and returns the boolean AND; `ctx.guard.failures()`
returns that recorded list from the most recent `all()` call — it is what becomes deopt
evidence in the template's `ctx.guard.failures()` call right after a failed `guard.all`.

`ctx.guard.noDialog()` has no supporting primitive today: `packages/browser`'s `Page`/`Driver`
interface has no dialog hook at all (`playwright-driver.ts` never touches
`page.on('dialog', ...)`). Do not fake this into always-`true` — that is worse than not having
it, because it would make every trace claim a guard passed that was never actually checked.
Add a minimal, additive dialog hook to `packages/browser`, mirroring the existing
`onNavigationRequest` pattern in shape (`CreatePageOptions`/`NetworkHooks` precedent): record
that a dialog fired since the page was opened (or since the last check — pick one and say
which), auto-dismiss it (a hung `alert()` would otherwise stall the run), and expose enough
for `ctx.guard.noDialog()` to read a real boolean. Keep the change small and additive — it
must not alter S3a/S3b/S4b's existing tests.

### 2. Script registry + migration (`packages/compiler`, migration in `packages/db`)

**Migration** (additive, `drizzle-kit generate`): `compiled_scripts` per §14 —
`id, task_id (fk → tasks.id), version int, source text, guards_meta jsonb, from_runs jsonb
(array of run ids), status text, created_at`. Named check constraint (matching the schema's
own convention for closed domains — see `RUN_STATUSES` etc. in `packages/db/src/schema.ts`)
`compiled_scripts_status_check CHECK (status IN ('candidate','active','invalidated'))`; unique
`(task_id, version)`. Add a partial unique index `compiled_scripts_active_task_key UNIQUE
(task_id) WHERE status = 'active'` — this makes "the active script for a task" a fact the
database itself enforces rather than an invariant S6c's activation logic has to get right
under concurrent writes; S6c's activation swap (old → `invalidated`, new → `active`) becomes
one transaction that this index makes safe.

**Registry functions** (`packages/compiler/src/registry.ts`), the calls S6b's `compileTask`
and S6c's executor/promotion logic need:
- `insertCandidateScript(db, { taskId, source, guardsMeta, fromRuns }) → CompiledScriptRow` —
  computes `version` as prior max + 1 for the task (starting at 1), inserts `status:
  'candidate'`.
- `getActiveScript(db, taskId) → CompiledScriptRow | null` — S6c's `CompiledExecutor` loader.
- `activateScript(db, scriptId) → void` — one transaction: any current `active` row for that
  script's task → `invalidated`, this row → `active`. Leans on the partial unique index above
  rather than a hand-rolled race check.
- `invalidateScript(db, scriptId) → void` — demotion path.

No "ScriptRegistry" class — a handful of functions over `db`, matching S6b's own "no
CompilerService" style rule and this repo's general aversion to speculative abstraction.

### 3. Lint gate (`packages/compiler/src/lint.ts`)

`lintScript(source: string) → { ok: true } | { ok: false; violations: LintViolation[] }`,
`LintViolation = { rule: string; message: string; line: number }`. AST-based, not
regex/string-match (a regex check on `"eval"` rejects the identifier inside a comment and
misses `globalThis["ev" + "al"]`). **Parser: the TypeScript compiler API**
(`ts.createSourceFile(..., ts.ScriptKind.JS)` + AST walk) — it is already a devDependency of
every package in this workspace, so using it costs nothing, consistent with S6b/S6c's own "new
deps: none" rule. (The parser choice is yours to make differently if you have a good reason;
record the reason if you deviate — but a new parser dependency for this is hard to justify
when one is already in every `package.json`.)

Reject, each as its own table row (extend the table the moment anyone thinks of a new escape
— same standing instruction as the hostile corpus and S6b's own lint-rejection tests):
`eval(...)`, `new Function(...)`, any `import`/dynamic `import()`, `with (...) {}`, and any
call expression whose callee is not a `ctx.*` member access chain (so `foo()`, `this
.constructor.constructor(...)`, and a bare `fetch(...)` are all rejected by the same rule,
not three separate ones). This is a **unit-level** test of the gate you built — S6b will
separately exercise the same gate through its own `compileTask` pipeline; that is expected
duplication of purpose, not of code.

### 4. Telemetry (`packages/telemetry/src/metrics.ts`)

Not yet in §17.2's catalogue by name — added under its "every later subphase adds its own
rows" growth clause (impl-phases §0.5), same clause S3b's `browserQueueRejected` and S5g/S5h's
rows were added under. Proposed, in the `Metrics` type + `createMetrics`'s style (typed
methods, bounded label sets, no `run_id`/`event_id` as a label):

- `staticRtKills: { add: (labels: { reason: "wall_clock" | "memory" }) => void }` →
  `static_rt_kills_total` counter. The security-signals-dashboard row for this sandbox,
  mirroring `pyrun_sandbox_kills_total{reason}`'s role for the Python one — should sit near
  zero outside of intentional hostile-corpus runs.
- `scriptLintRejected: { add: (labels: { rule: string }) => void }` →
  `script_lint_rejected_total` counter, mirroring the `store_sql_rejected_total` naming
  precedent named for S5g.
- `staticRtRunDuration: { record: (seconds: number, labels: { outcome: "completed" | "deopt" |
  "killed" | "error" }) => void }` → `static_rt_run_duration_seconds` histogram — instrument
  the primitive you built, since S6b's dry-run and S6c's real runs both call through it and
  neither should have to add this later.

### 5. System tests (`tests/system/`, content-named — e.g. `static-rt-sandbox.test.ts`,
`static-rt-ambient-globals.test.ts`, `compiled-script-registry.test.ts`, `script-lint.test.ts`)

- **Ambient globals, table-driven:** one row per identifier — `fetch`, `require`, `process`,
  `Buffer`, `setTimeout`, `setInterval`, `setImmediate`, `XMLHttpRequest`, `WebSocket`,
  `__dirname`, `__filename`, `module`, `exports`, `global` — asserting `typeof x ===
  "undefined"` evaluated inside the isolate's own global scope, outside of `ctx`. Assert `ctx`
  itself is the one thing defined.
- **Hostile corpus, table-driven** (impl-phases Phase 6 system-test bullet, verbatim scope):
  infinite loop → `{outcome: "killed", reason: "wall_clock"}`; memory bomb (unbounded array
  growth) → `{outcome: "killed", reason: "memory"}`; `this.constructor.constructor('return
  process')()` (and similar dynamic-eval-shaped escapes) → `process` (or whatever it
  resolves) is `undefined` inside the isolate regardless of how it's reached — the isolate
  boundary holds even for a script that somehow bypassed the lint gate, which is the point of
  testing this at the sandbox layer and not only the lint layer; direct network attempt
  (`fetch`, raw socket-shaped access) → no primitive exists to attempt it with, so this case
  asserts the *absence*, not a denial. Extend this table on every new idea, as the standing
  instruction requires.
- **Crossing/reuse, not reinvention:** a fixture script calling `ctx.page.goto` to a
  denylisted domain (via `HARNESS_NAV_ALLOWLIST`, `AllowAllGate`'s existing carve-out) is
  denied — proving the isolate call actually reached `RunSession`'s existing `PolicyGate`
  check rather than a bypass or a second, divergent gate.
- **`ctx.deopt` semantics:** a fixture script that calls `ctx.deopt(prompt, evidence)` and
  returns → `{outcome: "deopt", prompt, evidence}`, not `error`, not `killed`. A fixture
  script that throws without calling `deopt` → `{outcome: "error"}`.
- **Registry isolation:** enumerate the `ctx` surface object (recursively) and assert no
  `mcp`, `assets.write`, `assets.append`, or `page.evaluate`/`page.download` name appears
  anywhere in it — mirrors S5c's registry-isolation test for the same reason.
- **Script registry:** `insertCandidateScript` computes version = prior max + 1 (1 for a first
  script); `activateScript` flips old `active` → `invalidated` and the target → `active`
  atomically (assert both rows in one query, and that the partial unique index rejects a
  direct two-actives insert); `getActiveScript` returns `null` for a task with none.
- **Lint gate corpus, table-driven:** `eval`, `new Function`, `import`, dynamic `import()`,
  `with`, a non-`ctx` call (`foo()`), `this.constructor.constructor(...)`, top-level `fetch` —
  each rejected with a violation naming the rule; a clean fixture script (the §11-shaped one
  used elsewhere in this suite) passes.
- **End-to-end fixture run:** the hand-written fixture script (§11 template shape) run via
  `runCompiledScript` against a real `RunSession` on `fake-tweets` — completes, emits via the
  injected `EmitFn`, and its `ctx.state` write is readable back on a second run (proves
  `task_state` wiring, not `emitIfNew`'s dedupe specifically — that is S6c's flagship test's
  job once a real engine run exists).
- **Dialog hook:** `fake-tweets` (or a small new fixture route) triggers a `window.alert` at
  page-load; `ctx.guard.noDialog()` returns `false`; a page with none returns `true`.

## Style constraints (binding)
- No classes for the registry or the lint gate — functions over `db` / over a source string,
  matching S6b's own rule for the package it extends.
- `ctx` is data plus host-bound functions, not an object hierarchy the isolate reasons about —
  everything it can do is exactly the table above, nothing discoverable beyond it.
- New deps: `isolated-vm` only, justified and verified per above. No new AST-parsing
  dependency — the TypeScript compiler API already ships with every package.
- Traces are not this subphase's assertion surface (there is no run/trace machinery here yet)
  — `ScriptRunResult` and the registry's rows are. S6c is where trace assertions return.
- No UI. No engine/composition-root changes.

## Verification
```
pnpm install && pnpm build && pnpm test
```
All prior tests stay green; run twice (isolate caps and the dialog/network fixtures must be
deterministic, not flaky under load).

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Specifically:
which `isolated-vm` version, whether it used a prebuilt binary or built from source on this
Node 24 environment, and whether any fallback was needed (and if so, exactly how loudly it
says so). Whether `packages/browser` needed the dialog hook added, and its exact shape. Do
NOT git commit.
