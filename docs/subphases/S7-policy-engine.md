# S7 — Policy & permissions engine (the deferred piece, cashed in)

You are implementing subphase S7. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 7, and §0 (the PolicyGate precondition this subphase exists to cash in).
3. `docs/techical_plan.md` — §10 (policy engine, enforcement points, baseline pushback), §9 (network visibility + redaction), §16 (Threat 4, origin binding, Tier-2), §14 (`task_grants`, `account_baseline_rules`, `approvals`).
4. `docs/graph-compilation-llm.md` — §3.4–3.5 (store write grants + read fencing; their verdicts become real here).
5. `docs/subphases/ROADMAP.md` — stack/style rules + the platform-observability rule (§17.2 metric names).

Existing code to reuse (read first, match style): `packages/policy` (the `PolicyGate` interface and
`AllowAllGate` — your evaluator implements the SAME interface), and every injection site built in
S1–S6: `packages/browser` (navigation guard), `packages/agent` (tool registry), `packages/static-rt`
(ctx host), `packages/mcp`, `packages/assets`, `packages/secrets` (broker), `packages/engine`
(run state machine — the `awaiting_approval` slot was reserved in Phase 2), `apps/web`.

## Scope

The real policy evaluator, redaction, and approvals — swapped in for `AllowAllGate` **at the
composition roots only**. If any call site needs to change to accommodate the real gate, STOP:
that is a §0 interface leak; fix the call site in its owning package and report it as a deviation.
NOT in scope: the policy UI (U5 consumes your API), OPA or any external policy engine,
shared/hierarchical policies, request modification/replay (§9 non-goals).

## Deliverables

1. **Evaluator** (`packages/policy`):
   - Tables (Drizzle migrations if S1 trimmed them): `task_grants(task_id, grant_key, grant_value)`,
     `account_baseline_rules(user_id, rule_json)`.
   - Evaluation order, fixed and tested as such: **baseline denies → task grants → defaults**.
     Defaults: **deny** for network header/body reads and `secrets:read`; **allow** for basic page
     actions (click/type/scroll/waitFor) behind a rollout flag (`POLICY_DEFAULT_ALLOW_BASIC`,
     default true for migration, flipped to false later) — tightening must be config, not code.
   - Baseline rules are account-wide denies that task grants can NEVER override (§10 — accepted
     Decision 1). A verdict names the rule that matched (`{allow:false, rule}`); every decision,
     allow AND deny, is written to the trace.
   - Grant keys: navigation allowlist/blocklist (domain patterns), capability flags (click, type,
     scroll, execute-js, upload, download, form-submit, clipboard, purchase-class), network read
     parts (§9: request/response × headers/body), MCP tool allowlist, storage opt-outs,
     `requires_approval` markers on any grant.
2. **Enforcement points, all three (§10), wired:**
   - (a) **tool exposure** — un-granted tools are ABSENT from the agent's tool list (agent + MCP
     registries are built from the grant set), not denied at call time.
   - (b) **runtime interception** — every action, from the agent or from compiled JS via `ctx`,
     is checked before the CDP command is sent.
   - (c) **navigation guard** — per-task allowlists replace `HARNESS_NAV_ALLOWLIST` as the task
     rule; the env var is NOT deleted — it remains as an instance-level floor evaluated like a
     baseline deny.
3. **Redaction filter** — `PolicyGate.redact` stops being identity: `Authorization`,
   `Cookie`/`Set-Cookie`, and configurable token patterns are masked in agent-bound network
   payloads even under a `headers:read` grant; unmasked only with the separate, louder
   `secrets:read` grant (§9 step 4). Raw values still reach the (opted-in) trace — redaction
   protects LLM context, not storage.
4. **Approvals**: `approvals(id, run_id, action_json, status, expires_at)`. A `requires_approval`
   grant parks the run in `awaiting_approval`, leaves the page untouched, emits
   `approval.requested`. tRPC endpoints (the U5 inbox API): list pending, approve, deny.
   Approve → the parked action executes and the run resumes; deny → run fails `policy_denied`;
   expiry (engine watchdog, same pattern as run timeouts) → run fails `approval_expired`,
   `approval.denied` emitted.
5. **Phase 5/5g surfaces become real verdicts**: MCP tool allowlist per asset task (point (a));
   asset writes tightened from "any user path" to `asset_write_grants.path_glob`; `secret_grants`
   enforced by the broker (origin binding shipped in S5b and is a property of the secret — no
   migration here); `store_write_grants` table checks on `store.insert/upsert` + the decision
   node's per-run query budget; `upload`/`download` capability grants gating `page.upload` and
   download-to-asset.
6. **Tier-2 secrets** (**cut this first if the subphase runs long** — §18 open 4): DEK
   additionally wrapped by an Argon2id passphrase-derived key, derived client-side, never
   transmitted; attended-only. A scheduled run needing a Tier-2 secret parks via deliverable 4's
   approval machinery, unchanged.
7. **Telemetry** (SOb names, binding): `policy_verdicts_total{decision, check}` with real rule
   labels; approval parks and expiries counted.
8. **System tests** (`tests/system/`, content-named):
   - **Decision-table tests** on the evaluator alone: exhaustive grant × action matrix as
     data-driven cases — this is where most policy bugs die cheaply. Cover baseline-overrides-grant,
     default-deny reads, default-allow flag off/on.
   - Enforcement points: (a) un-granted tool absent from the captured tool schema (replay
     adapter); (b) compiled script calling an un-granted `ctx` method → denial → deopt-or-fail
     per config, `policy.denied` traced; (c) mid-run redirect to an off-grant domain aborted.
   - Redaction: fixture endpoint returning `Set-Cookie` + bearer token; with `headers:read` only
     → masked in agent context (assert transcript), raw in opted-in trace; with neither → read denied.
   - Approvals: purchase-class action on fake-gram with `requires_approval` → parks, event
     emitted, API approve → resumes and completes; expiry path → `approval_expired`.
   - Store grants: asset write outside `store_write_grants` → denied + traced; decision-node
     query-budget breach → run fails.
   - Tier-2: cron run needing a Tier-2 secret parks; attended approve resumes; expiry fails it.
   - **Regression sweep: the ENTIRE Phase 2–6 suite re-runs under a permissive-grants profile
     and must pass unchanged — if it fails, the §0 interface leaked.** Build the profile as a
     test helper that grants everything; this sweep is the exit criterion, not an afterthought.

## Style constraints (binding)
- The evaluator is an in-process pure function over grant rows: `(taskCtx, subject) → Verdict`.
  No OPA, no rule DSL beyond the grant keys named above, no caching until a test proves the need.
- The ONLY composition-root change is `AllowAllGate` → real gate. The diff outside
  `packages/policy`, composition roots, migrations, and tests should be ~zero; justify every
  exception in the report.
- New deps: none expected; justify anything.

## Verification
```
pnpm install && pnpm build && pnpm test && pnpm --filter web lint
```
All prior tests stay green (that IS the regression sweep). Run the full suite twice.

## Report back
What you built, deviations + why (especially any §0 leak you had to fix), commands + outcomes,
whether Tier-2 was cut, flakiness noticed. Do NOT git commit.
