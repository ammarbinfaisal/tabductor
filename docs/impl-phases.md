# Implementation phases

Version 1.0 delivery roadmap for hosted browser workflows. The target architecture is defined
in [the technical plan](techical_plan.md). New hosted phases below are planned; this roadmap
does not claim that accounts, payments, Camoufox, or Kubernetes deployment already exist.

## 1. Existing foundation

| Phase | Outcome | Current state |
| --- | --- | --- |
| S0–S2 | Workspace, migrations, event bus, engine, scheduler, versioned graph API | Implemented foundation |
| S2d | Token-scoped public workflow/run/event reads | Implemented foundation |
| S3 | Chromium CDP driver, endpoint pool, navigation/network/resource guards | Implemented; hosted path will use Camoufox |
| S4 | Browser perception and AI agent loop | Implemented; needs remote-worker cancellation and recovery |
| S5 | Secret injection and workflow-store decision query/insert/upsert | Implemented; needs account ownership |
| S6 | Guarded static runtime and post-execution trace compilation | Implemented; needs browser compatibility and metering |
| S7 | Policy grants, approvals, account baselines | Implemented; retire action approval model |
| S8 | Natural-language graph/store compiler and deterministic gates | In progress; finish under the new execution contract |
| S8.5 | Workflow-level MCP publish/update/trigger/schedule | Implemented; needs account authentication and execution IDs |
| S9 | Evidence-driven Graph Optimizer and typed Graph Patch IR | Deferred until hosted runtime is proven |

Browser tasks retain adaptive AI execution, script promotion, and AI recovery. Decision tasks
remain AI-driven and own workflow-store operations. Customers author intent and inspect
behavior. The new Python service owns Camoufox; it does not restore the retired customer
Python runner, asset task kind, document renderer, or external MCP tool registry.

## 2. Delivery sequence

Deliver H0–H7 through local staging before deploying H8 to AWS staging. H0 establishes the
shared deployment/test harness incrementally; its initial chart boots only existing services.
Extend it with each phase rather than waiting for the full platform to exist. Each phase
must satisfy its acceptance gate before its dependent phase is considered complete.

### H0 — Local staging foundation

- Add a shared Helm chart and local/AWS values, plus kind configuration under `infra/`.
  Local kind has one control-plane node, two worker nodes, and a NetworkPolicy-capable CNI.
- Implement `pnpm staging:up`, `staging:down`, `staging:reset`, `staging:test`, and
  `staging:test:live` as scripts with documented prerequisites: container runtime, kind,
  kubectl, Helm, and sufficient local CPU/memory/disk.
- Build application images, load them into kind, deploy Postgres/MinIO and existing services,
  run migrations as a job, and expose a loopback gateway. Persist staging data and wrapping
  keys outside disposable kind nodes. Use a dedicated kubeconfig and staging state directory.
- Add deterministic model/provider adapters, two fixture account identities, fixture sites,
  and test credits as later services become available. Make these explicit test-only settings
  that hosted deployments reject. Keep existing Compose development usable.

Acceptance: a clean checkout can create staging reproducibly; a second up is idempotent;
down/up preserves data; reset removes only staging data. No AWS account, paid model call,
live payment, or real solver request is needed for the deterministic suite.

### H1 — Clerk accounts and removal of action approvals

- Integrate Clerk and account resolution across server rendering, tRPC, workflow chat, MCP,
  and background work. Add revocable account MCP tokens and an account ownership query layer.
- Backfill existing data to an explicit owner and enforce ownership on workflows, stores,
  secrets, traces, artifacts, and future browser/model resources. Preserve scoped public shares.
- Remove grant proposals from graph artifacts/prompts, approval controls from the UI, and
  permission-gate calls from runtime paths. Extract redaction and resource enforcement before
  removing the policy package dependencies.
- Retire `awaiting_approval` and approval polling. Drain or explicitly terminate legacy
  waiting runs during migration; never auto-approve old work. Preserve historical audit data.
- Finish the S8 intent/chat surface and deterministic compile reports without grant proposals.

Acceptance: two accounts cannot access each other's resources through UI, tRPC, MCP, object
references, or share tokens. Normal authoring and execution require no action approvals.
Secret hygiene, registry separation, store isolation, and resource-limit tests still pass.

### H2 — Durable workflow executions and robust graphs

Implementation notes (2026-09-18): event/store commits and compiled task-state writes now
lock and validate the active run generation in their committing transaction. Decision AI
observes cancellation; compiled scripts fence every host call after cancellation. Regression
coverage includes cancelled/replaced owners and rollback of emit dedupe claims with writes.
Trigger roots and schedule claims commit atomically; failure and retry creation share one
transaction. Durable completion waits for descendant attempts and outbox delivery. Recovery
marks abandoned real-browser attempts `browser_outcome_uncertain` without automatically
replaying them. Delivery dead letters retain execution identity, and loop-budget notices
cannot recursively generate more notices.
These checks are part of H2; the full acceptance gate below remains required.

- Add execution identity to triggers, events, task attempts, and system events. Atomically
  create roots and pin the complete execution to one published graph version.
- Strengthen typed graph validation, stable task identities, explicit entry behaviors,
  declared external inputs, bounded cycles, and compare-and-set publication.
- Preserve per-event consumer semantics; do not treat multiple subscriptions as an implicit
  join. Keep finite hop/run budgets and terminal execution accounting.
- Make dedupe claims, event publication, and staged store writes atomic. Separate delivery
  dedupe from intentional cross-execution record dedupe.
- Add lease generations and propagate cancellation through both AI and compiled executors.
  Fence stale database commits and browser commands. Track uncertain browser action outcomes
  rather than automatically replaying side effects after a crash.
- Block incompatible store migrations until affected executions, including pauses and queued
  descendants, drain. Require new execution IDs after the routing cutover.

Acceptance: publishing while A executes cannot move its downstream B into another version.
Duplicate triggers/deliveries, concurrent publication, crashes around emit, retries, cycles,
cancel races, and stale-owner writes have deterministic outcomes. Execution completion waits
for pending outbox delivery and all descendants.

### H3 — Camoufox worker, profiles, and local fleet

- Add a Python browser-worker image with pinned Camoufox/Playwright, Xvfb, and a versioned
  internal RPC contract implementing the TypeScript browser-driver operations. Validate
  Firefox perception, frames, popups, secret injection, network bodies, and disconnection.
- Add durable browser profiles, sessions, allocation requests, profile locks, and generation
  checks. Bind sessions to verified execution or interactive profile-setup ownership.
- Implement the Kubernetes fleet controller using account-fair scheduling and the existing
  Postgres queue. Local limits are one unassigned warm slot, three allocated browsers, and
  four total pods. Provision only after concurrency and credit admission.
- Use clean per-session pods; restore encrypted profile snapshots, preserve fingerprint/proxy
  settings, and atomically publish snapshots after clean browser shutdown. Keep the last
  clean generation on crashes. Destroy used workers instead of returning them to the warm pool.
- Retain a fixed-worker Compose mode for fast development. The hosted UI automatically
  provisions browsers and offers profile setup instead of requiring a pasted CDP endpoint.
- Use a temporary test reservation adapter until H6 supplies real credit accounting.

Acceptance: a real fixture login survives browser replacement and staging redeployment;
competing users cannot share a profile lease; a fourth session queues and later starts.
Killing a worker/controller cannot create duplicate ownership. Browser requests cannot reach
platform services, cloud metadata, or another session. Chromium compatibility assumptions
are absent from the hosted driver.

### H4 — Live sessions, playback, and takeover

- Add an authenticated VNC/WebSocket gateway and embedded noVNC viewer. Enforce read-only
  viewers and exclusive human input at the server, with short-lived session-scoped access.
- Record Xvfb output into recoverable HLS segments in object storage. Persist manifests,
  session-relative timestamps, page/tab metadata, and media availability/gap states.
- Stream durable cursor-addressable activity and periodically flush trace buffers. Add a
  session inspector with live browser, action timeline, playback controls, and event seeking.
- Implement pause acknowledgment, input-owner generations, explicit resume, disconnect
  handling, stop, and takeover timeout. Resume with fresh AI perception; compiled isolates
  exit at a host-call boundary without restarting completed actions.
- Suppress recorded media during takeover and explicit secret injection; retain private
  timeline intervals. Exclude human input values from traces and human-assisted runs from
  script promotion. Add seven-day recording cleanup.

Acceptance: agent and human cannot issue concurrent input, including during worker/network
races. MFA fixture takeover resumes correctly. Reconnecting viewers recover missed events.
Playback seeks to the matching action and remains usable after a crash; expired or foreign
tokens cannot view media or control input. Cancellation stops further commands.

### H5 — Account model sources and complete metering

- Store encrypted BYO OpenAI/Anthropic credentials and workflow model settings. Resolve one
  funding source across authoring, schema/graph compilation, runtime, recovery, and trace
  compilation. Platform-managed credentials implement paid Tabductor models.
- Unify runtime and compiler usage reporting with operation IDs, provider/model, token
  categories, purpose, funding source, and pinned rate versions. Remove boot-global customer
  provider selection and approximate fallback rates from billable paths.
- Pin compiled artifact/browser compatibility, preserve evidence-only validation, and demote
  incompatible or repeatedly failing scripts. Meter background compilation after a run ends.
- Surface BYO failures without changing funding source. Keep raw credentials out of API
  responses, browser workers, transcripts, logs, and recordings.

Acceptance: every model phase attributes usage to the correct account and selected source.
A BYO failure never produces a platform-model debit. No billable model runs without a known
rate. Deterministic fixtures verify usage attribution; bounded live tests verify adapters.

### H6 — Paddle prepaid credits and spending enforcement

- Add configured credit packs, server-created Paddle transactions, checkout, verified
  webhooks, and a customer billing screen. Use Paddle sandbox in local staging.
- Implement the append-only credit ledger, payment-event inbox, purchase reconciliation,
  refunds/adjustments, and atomic credit reservations using integer units.
- Credit completed transactions exactly once. Derive credit amounts from the server price
  mapping; reject mismatched purchases. Handle duplicate and out-of-order webhook delivery.
- Replace H3's test reservation adapter with allocation admission, browser interval charging,
  model/solver reservations, proxy usage, settlement, and abandoned-operation reconciliation.
- Expose available/reserved balance and usage breakdown; enforce per-account and execution
  limits. Queue/warm capacity is unbilled; held human sessions remain billable. Implement
  compensating refund entries and block new spending when balance is insufficient.

Acceptance: successful, abandoned, failed, duplicate, and refunded sandbox purchases have
correct balances. Concurrent runs cannot overspend one account. Worker crashes, delayed usage,
and duplicate settlements do not create free or duplicate usage. Unknown provider outcomes
remain reconcilable. Checkout redirects alone never credit an account.

### H7 — Managed proxies and challenge recovery

- Integrate platform-owned proxy configuration with stable per-session assignment, profile
  locale/fingerprint settings, byte metering, and encrypted provider credentials.
- Implement CapSolver, 2Captcha, and Anti-Captcha adapters with a capability map and configured
  fallback order. Detect, submit, poll, apply, and verify supported challenges.
- Persist each provider request, enforce at most three submissions and a two-minute challenge
  deadline by default, and apply credit limits before calls. Handle ambiguous submissions
  without immediately creating another paid attempt.
- Show challenge attempts/costs in the session timeline. Request human assistance for
  unsupported challenges, exhausted attempts, login, or MFA; resume through H4's controls.

Acceptance: deterministic provider fixtures cover success, unsupported types, timeout,
provider outage, fallback, invalid solutions, insufficient credits, and duplicate polling.
Run bounded provider demo/test challenges in explicit live mode. Verify page recovery and
charge attribution separately; do not claim universal anti-bot coverage.

### H8 — AWS staging, autoscaling, and launch

- Provision one-region EKS, a baseline managed node group, a bounded Karpenter browser
  NodePool, RDS, S3, ECR, workload identities, encryption, and HTTPS ingress through IaC.
  Deploy the same Helm chart and image digests used in local staging.
- Start with On-Demand browser nodes, two warm slots, 25 allocated-browser capacity, and
  27 total browser pods. Karpenter adds nodes for pending pods; the fleet controller owns
  session allocation and idle-slot retirement.
- Configure network isolation, account-scoped storage access, production secret injection,
  drain-aware deployments, active-session disruption protection, and expired-lease recovery.
- Add dashboards/alerts for queue age, allocation latency, worker health, stale leases,
  browser memory, streaming lag, recording loss, provider failures, and ledger reconciliation.
- Use separate AWS staging credentials/data and Paddle sandbox before enabling production
  Clerk/Paddle settings. Document backup/restore and rollback; do not roll application code
  back across an incompatible schema transition.

Acceptance: a 25-browser load test and a larger queued burst preserve account fairness and
correct billing. Observe real EC2 scale-out and idle scale-in; active sessions survive
voluntary consolidation. Test forced node loss, draining, S3/RDS disruptions, profile restore,
and duplicate payment delivery. Measure cold/warm startup and viewing latency before setting
customer-facing service guarantees.

## 3. Local staging acceptance journey

Automated staging defaults to fixture identities, model responses, provider responses, and
synthetic payments. These adapters exercise the real ownership and ledger interfaces and
are unavailable in hosted mode. Fixture websites include login/MFA, popups, changing layouts,
delayed responses, a side-effect counter, and challenge success/failure pages.

1. Start staging with one command; create two accounts and confirm isolation.
2. Top up fixture credits, select a BYO or Tabductor model source, publish an intent, and
   trigger a workflow without configuring a browser endpoint or granting actions.
3. Observe automatic Camoufox allocation, live activity, successful output, usage settlement,
   and a replay whose action timestamps match the recorded browser.
4. Take over a login/MFA flow, resume it, and restore the saved profile in a later session.
5. Run enough independent profiles to exceed three browsers; verify fair queueing, exclusive
   profile ownership, warm-slot replenishment, and idle scale-in.
6. Publish a new graph mid-execution; verify the original descendants remain on their
   original version. Exercise duplicate events and failures around publication/settlement.
7. Kill a worker, restart the engine and controller, interrupt object storage, and disconnect
   the viewer. Verify fencing, bounded recovery, partial recordings, and ledger reconciliation.
8. Redeploy staging and verify persistence; separately exercise the explicit reset command.

The live journey uses Clerk's development instance and Paddle sandbox with a documented HTTPS
tunnel for callback delivery. Complete real sign-in and a sandbox checkout, then test a bounded
workflow using explicit live model/proxy/solver credentials. Replay signed webhook fixtures
for deterministic regression coverage, but require a real sandbox webhook round trip before
declaring the Paddle integration complete.

Local kind scales browser pods inside fixed local nodes. It does not prove EC2 autoscaling,
AWS identity/network rules, managed-service failure behavior, or production capacity. Those
remain H8 gates. Host sizing checks must fail clearly when local resources cannot support the
configured limit; a lower test limit cannot be reported as passing the full capacity gate.

## 4. Release and migration gates

- Run TypeScript build, web build, lint, relevant Python worker checks, unit/system tests,
  and real Camoufox staging tests. Validate Helm rendering and Kubernetes readiness.
- Test both a fresh database and an upgrade from the current single-user/CDP schema. Preserve
  workflows, store data, historical runs/traces, and audit records; applied migrations remain
  immutable. Backfill explicit ownership and drain old routing work before cutover.
- Complete Clerk development and Paddle sandbox journeys, account isolation tests, secret
  leak checks, credit reconciliation, recording expiry, and human takeover races.
- Keep exactly four workflow-level MCP tools; authenticate all of them and return execution
  identity without exposing graph internals or private browser connection endpoints.
- Pass local staging H0–H7, then AWS staging H8, before enabling self-service production.
  Required deployment inputs include provider credentials, credit-pack price mappings,
  unit rates, model catalog, proxy configuration, AWS region, and domain names.

## 5. S9 — Graph Optimizer after hosted launch

The optimizer observes completed runs and produces a typed Graph Patch IR with a base version.
It never executes workflow work or mutates active graph rows. Candidate changes include
splitting/merging tasks, event rerouting, deterministic predicates, and store migrations.

Use evidence such as repeated browser deopts, repeated normalization work, always-coexecuted
decisions, separable phases, and repeated visits to the same profile. Validate candidates
against recorded evidence and the publication gates; reject stale base versions and preserve
active execution pinning. User feedback is attributed evidence for a candidate, not authority
to mutate runtime state directly.
