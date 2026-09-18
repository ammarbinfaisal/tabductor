# Tabductor technical plan

Version 1.0 target — hosted browser workflows with Camoufox, observable sessions, and usage billing.

This document describes the target architecture. The hosted path now includes Clerk account
resolution, versioned executions, automatic Camoufox allocation, encrypted profiles/media,
viewing/takeover, account-selected models, prepaid accounting, and bounded challenge recovery.
CDP remains the development path. The shared chart and AWS infrastructure are partially
provisioned; the complete acceptance journey and launch gates remain open.
[Implementation phases](impl-phases.md) records current evidence and outstanding work.

## 1. Product boundary

Tabductor hosts browsers for AI-driven workflows. Customers describe intent, connect an
account through a persistent browser profile, and watch work happen live. They can replay
completed sessions or take control for login, MFA, and recovery. The graph is an internal,
versioned implementation detail produced by the compiler; customers do not wire nodes or
approve individual browser actions.

The first release is self-service paid SaaS: Clerk accounts, Paddle prepaid credits,
customer-supplied model keys or paid Tabductor models, and platform-managed proxies and
CAPTCHA services. Production runs on AWS EKS in one region, initially validated for 25
concurrent browsers. Fetch/Search APIs, arbitrary hosted functions, standalone public browser
connections, and a general-purpose model gateway are later products.

The external automation API remains MCP at `/api/mcp`, with four workflow-level operations:

- `workflow_publish(name, intent, max_hops?)`
- `workflow_update(workflow_id, intent)`
- `workflow_trigger(workflow_id, request_id?)`
- `workflow_schedule(workflow_id, cron, timezone?, enabled?)`

UI/tRPC and MCP call the same authenticated workflow services. Trigger responses include an
execution ID. Reuse `request_id` after an uncertain response to recover the same execution,
even if the workflow has since been republished. Session inspection and control use dedicated authenticated APIs; callers do
not need internal task IDs or browser connection URLs.

## 2. Accounts and ownership

Clerk authenticates customers. Each customer starts with a personal account; the account is
the unit of ownership, resource limits, credentials, and billing. Keep account identity
separate from Clerk user identity so additional members can be supported later.

Resolve account access server-side for every UI, tRPC, MCP, streaming, and artifact request.
Workflow versions, executions, runs, profiles, sessions, model credentials, recordings, and
usage records must resolve to the same account. Background workers carry this verified
ownership context. Replace `LOCAL_USER` in hosted paths; arbitrary request fields never
establish ownership. MCP uses revocable account API tokens stored as hashes.

Existing public share tokens retain their explicit read scope. They do not grant access to
live sessions, takeover, browser profiles, private recordings, credentials, or billing.

## 3. Internal execution model

There are exactly two internal task kinds:

| Kind | Responsibility | Runtime capabilities | Compiled fast path |
| --- | --- | --- | --- |
| Browser | Navigate, perceive, extract, and act in hosted Camoufox | `page.*`, redacted network reads, emit/lifecycle | Yes |
| Decision | Semantic transformation, normalization, planning, and durable state | Workflow-scoped `store.query`, `store.insert`, `store.upsert`, emit/lifecycle | No |

Browser tasks do not query or write the workflow store. Decision tasks do not open pages,
run customer Python, render documents, or call third-party MCP servers. The Python browser
worker is infrastructure for Camoufox, not a new task kind or a general-purpose code runner.

Authored work starts in `ai` mode. Successful browser traces can be promoted to guarded
static scripts; failed guards hand control back to AI within the same run and browser
session. Decision tasks remain AI-driven. `stub` is reserved for deterministic tests.

### Execution, run, profile, and session

| Entity | Meaning |
| --- | --- |
| Workflow version | Immutable published graph, event contracts, and resource bindings |
| Workflow execution | One trigger and its entire causally related graph traversal, pinned to a version |
| Task run | One task attempt within an execution; retries preserve execution identity |
| Browser profile | Persistent login data, fingerprint configuration, and proxy configuration |
| Browser session | One live browser lifetime, owned by an execution or an interactive profile setup |
| Recording | Time-indexed media and activity metadata for one session |

A workflow defaults to its own persistent profile. Sharing a profile between workflows is
explicit. Only one session can hold a profile for writing; competing executions queue.
Browser tasks using one session act serially. Independent profiles permit parallel browser
work. Decision-only executions allocate no browser.

## 4. Graph compilation, routing, and durability

Retain the event-centric graph. Tasks declare the event types they consume and emit; matching
declarations derive topology. Each matching event triggers a consumer independently:
multiple subscriptions do not implicitly create a join. Events carry schema-validated
packets, account/workflow/execution identity, and causation.

Resolve the current workflow version once when accepting a manual trigger, external event,
or schedule occurrence. All downstream events, retries, and system events stay on that
execution's version. Publishing a new version affects subsequent executions. The implemented
execution-scoped router preserves that version across downstream delivery and retries.

The typed publication artifact contains:

- A versioned graph with stable logical task identities, browser/decision kinds, event
  declarations, explicit entry behaviors, and finite execution budgets.
- Compiled event schemas and task briefs.
- An optional workflow-store schema and classified migration.
- Browser-profile and model-configuration references, with ownership validated at publication.

Remove proposed grants from this artifact. Deterministic gates validate shape, identity,
event wiring, declared external/system inputs, entry behaviors, kind constraints, resource
bindings, store DDL/table specifications, and bounded cycles. Failed repair attempts leave
the published version untouched. Publication uses a base-version check so concurrent
updates cannot silently overwrite each other.

Keep the Postgres outbox and durable queue. Atomically accept triggers, create execution
roots, deduplicate deliveries, and commit emitted events with staged store writes. The implemented
transactional emit path prevents a crash from consuming a dedupe key without publishing
its event. Distinguish execution-scoped delivery dedupe from intentional
cross-execution record dedupe.

Execution completion requires all descendant runs and pending event deliveries to settle;
an empty in-memory queue is insufficient. Aggregate terminal status, release sessions, and
settle usage once. Queued work, retries, and human pauses count toward execution liveness.

Run and session leases carry an owner and monotonically increasing generation. Heartbeats,
browser commands, event/store commits, and completion writes must reject stale owners.
Cancellation revokes command access and stops executors, rather than only changing a row.
Record browser command intent and outcome. After a disconnect during a potentially
side-effecting action, do not blindly replay it: inspect available evidence, and mark an
unverifiable outcome as requiring recovery. Arbitrary website effects cannot be made
exactly-once by database deduplication.

Store data persists across workflow versions. Additive compatible migrations can publish
while older executions continue; incompatible migrations wait for all affected executions
to drain. Destructive data changes remain explicit migration operations. These are data
lifecycle controls, not browser action approval prompts.

## 5. Camoufox worker and persistent profiles

Use a Python service owning Camoufox through its supported local Playwright API. The
TypeScript driver calls a versioned internal RPC API that implements the existing browser
operation contract. The browser worker owns page handles, network observations, display,
and input; model calls and graph execution remain in the TypeScript services.

Camoufox's remote Playwright server is documented as experimental. The local-owner worker
avoids making that server the production connection contract. Chromium CDP discovery,
`newCDPSession`, and CDP navigation interception are replaced in the hosted path by
Playwright Firefox operations and infrastructure-level network isolation.
See [Camoufox remote server](https://camoufox.com/python/remote-server/) and
[persistent contexts](https://camoufox.com/python/usage/).

Each allocated pod hosts one customer session: Camoufox, an Xvfb display, the worker, and
display/recording processes. Pin compatible browser, Python package, and Playwright versions
in the image; download browser binaries during builds. Browser pods have finite CPU,
memory, disk, tabs, and lifetime limits and no access to the Kubernetes API or host sockets.

Launch with a persistent user-data directory and the profile's stored fingerprint settings.
Store encrypted profile snapshots in account-scoped object storage. Restore under an
exclusive profile lease, close the browser before producing a clean snapshot, upload a
new generation, and atomically advance the profile pointer. Retain the last clean snapshot
when a worker dies; record that newer login changes may be lost. Never share a writable
profile directory or recycle a used customer browser into the warm pool.

Persist locale, timezone, fingerprint, and proxy preferences together. Keep a sticky proxy
assignment during a session; an expiring provider assignment does not imply a permanent IP.
Interactive profile setup uses the same session, takeover, and metering paths as workflows.

The frontend exposes profile creation, workflow binding, and an interactive session with an
address bar. Users take control to navigate and sign in, then stop to save the encrypted profile.
An explicit Chrome extension import can transfer a selected origin's cookies and complete
localStorage into an idle profile. A short-lived, single-use capability binds each transfer
to an account, profile and origin. Imports never read profile secrets back to the extension.
The worker applies imports before recording, preserves session cookies across clean browser
replacement, and clears pending imports only after publishing a clean encrypted snapshot.
Other origins require separate transfers; IndexedDB, passkeys, device-bound credentials and
partitioned-cookie authentication are outside this portable import format.

Authoring starts with a user-facing automation prompt, written directly or prepared by chat.
The checked draft stores that prompt with its version; internal task instructions remain
separate. Building does not publish or run. The main views are Automation and Activity; Graph
is available only as a separate local inspection tab. Missing runtime sign-in is handled by
profile setup, not by asking the author to host a runner or supply website API credentials.
A persistent profile stores browser state, not a checkpoint of arbitrary running JavaScript.

## 6. Live viewing, playback, and human takeover

Use Camoufox with a virtual display. Camoufox documents Xvfb support for this mode:
[virtual display](https://camoufox.com/python/virtual-display/). Live viewing uses a
VNC/WebSocket display gateway and an embedded noVNC client; the gateway authenticates
account/session access and enforces read-only versus input ownership server-side.

Record the display with FFmpeg into independently recoverable HLS segments in object
storage. Use a session-relative clock to align media with page/tab identity, task actions,
network metadata, AI/compiled transitions, human control, and challenge attempts. Playback
is a seekable recording of what happened, not re-execution of website actions. Preserve
finished segments after a crash and show explicit gaps or incomplete recording status.

The session screen gives the live browser primary space, an activity timeline, and clear
take-control, resume, and stop controls. Completed sessions expose play/pause, seek, speed,
and jumps from timeline events to recording positions. Persist trace entries on both a
bounded interval and a size threshold; stream cursor-addressable activity updates so
reconnections can recover missed events.

Taking control requests an agent pause. Grant input only after the worker acknowledges the
command boundary and revokes the automation generation. There is one input owner at a time.
A disconnected human leaves automation paused until explicit resume or the takeover timeout;
resume requires fresh perception and preserves committed events and task progress. For
compiled execution, exit the isolate at a host-call boundary and resume through AI rather
than continuing with stale selectors or restarting the script from the beginning. Unfinished
actions with uncertain outcomes follow the recovery rule in section 4.

Credential values and human keystrokes are excluded from structured traces. Suspend recorded
media during human takeover and explicit secret injection, showing a private interval in
playback; live viewing remains available to the authenticated owner. Network authorization
headers and known secrets are redacted before persistence or model access. Recording
retention defaults to seven days, with deletion of media and associated access links.
Takeover defaults to a ten-minute idle timeout; browser time remains billable while held.
Human-assisted traces are ineligible for automatic script promotion.

## 7. Execution boundaries without action approvals

Remove user-configured task grants, grant proposals, approval queues, approval baselines,
per-action permission prompts, and the `awaiting_approval` runtime path. Publishing intent
and starting a workflow authorizes execution within its account and configured resources.

Preserve structural browser/decision tool separation, secret injection, account ownership,
schema validation, redaction, and resource/spending limits as dedicated runtime services.
Do not replace the policy package with an allow-all implementation that also drops those
protections. Secret references resolve only within the account and configured workflow
bindings; a model key is never exposed to the browser.

Static scripts retain no ambient process, filesystem, module-loader, or network access.
Workflow SQL retains its fenced reader/writer roles. Browser egress cannot reach cloud
metadata, databases, control-plane services, or other customers' workloads. Enforce this
outside page-level navigation hooks so redirects and subresources receive the same boundary.
Local fixture destinations are an explicit staging-only network exception.

## 8. Models, compilation, and usage

A workflow selects one funding source for every model phase: BYO credentials or Tabductor
credentials. This covers chat/authoring, graph/schema compilation, browser and decision
execution, recovery, and post-run trace compilation. Start with the existing OpenAI and
Anthropic adapters. Resolve credentials per account and operation rather than once at boot.
An invalid or exhausted BYO key never silently switches to paid Tabductor models.

Route all model calls through a shared metered resolver, including compiler transports that
currently return only text. Record provider, model, purpose, token categories, funding
source, operation ID, applicable rate version, and related workflow/execution/run or compile
job. Store API keys encrypted and return only masked metadata to clients. Tabductor model
rates and supported models are configured explicitly; unknown rates cannot become billable
estimates through the current fallback price table.

Trace compilation remains post-execution work. It validates candidates against recorded
evidence in isolation, never by repeating live website effects. Promotion verifies the task
content hash and browser/runtime compatibility. Runs pin the script artifact they acquire;
browser upgrades invalidate incompatible artifacts. Guard failures recover in the same
session, and repeated failures demote the script.

## 9. Paddle payments and prepaid accounting

Use Paddle Checkout for one-time credit packs. The server maps configured Paddle price IDs
to credit units, creates a purchase linked to the authenticated account, and opens checkout.
Credit quantities are determined by that server-owned mapping, not client-submitted totals,
tax amounts, or arbitrary checkout metadata.

Verify webhook signatures against the raw body and durably deduplicate delivery IDs.
Apply credit once per completed Paddle transaction in the same database transaction as the
ledger entry. Browser redirects never grant balance. Reconcile refunds, adjustments, and
out-of-order notifications against the purchase, using compensating ledger entries.
See [Paddle transactions](https://developer.paddle.com/build/transactions/create-transaction/)
and [transaction.completed](https://developer.paddle.com/webhooks/transactions/transaction-completed/).

Tabductor owns an append-only credit ledger and atomic reservations. Reserve a bounded
amount before allocating a session or issuing a paid model/solver request; settle actual
usage and release unused reservations. Browser reservations renew in short intervals.
Concurrent runs cannot spend the same balance. Failed top-ups grant nothing; refunds or
chargebacks can place an account in debt and block new reservations.

Meter browser allocation time, Tabductor model usage, proxy bytes, and chargeable CAPTCHA
attempts. Browser charging starts when a session is ready and stops when it is terminated;
queued work and unused warm slots are platform costs. BYO model usage is visible but has
zero Tabductor model debit. Bill provider attempts according to their actual charge outcome,
including failed paid attempts, with no duplicate debit for polling or webhook retries.

Persist operation IDs and provider request IDs for reconciliation after crashes. Missing
usage stays pending until reconciled; do not fabricate zero usage or blindly repeat a paid
request after an ambiguous timeout. Enforce account and execution spending ceilings before
new work. Low balance stops further allocation and actions once reserved work is exhausted.
The UI shows available/reserved credits and the cost breakdown. Pack sizes, unit rates, and
model margins are operator configuration required before paid launch.

## 10. Proxies and CAPTCHA handling

Tabductor supplies proxy and solver credentials. Add adapters for CapSolver, 2Captcha, and
Anti-Captcha behind a common challenge interface: detect, submit, poll, apply, verify, and
report charge outcome. Keep a provider capability map and operator-configured ordered
fallback list; providers support different challenge types.

Use the session's proxy and browser context where required. Default to at most three solver
submissions and a two-minute deadline per challenge, within execution and credit budgets.
Persist a submission ID before polling; resolve an ambiguous submission before trying another
provider. Avoid simultaneous paid attempts for one challenge. Trace provider, challenge type,
status, latency, and cost without persisting solution tokens.

Successful solutions are verified against the page. Unsupported challenges, exhausted
attempts, and login/MFA requirements transition to a visible human-assistance state. These
are intervention states, not permission approvals. Network/account restrictions remain in
force during both automated and human control.

## 11. AWS deployment and browser autoscaling

Deploy the Next.js control plane, execution/compile workers, fleet controller, and streaming
gateway on EKS. Use RDS Postgres for durable state, S3 for profiles/recordings/artifacts, ECR
for images, and KMS/Secrets Manager for production key material. Services use scoped workload
identities; customer browser processes receive no general AWS credentials.

The fleet controller reconciles durable session requests into individual pods. Provision
only work admitted by account concurrency, profile leases, and spending reservations.
Use fair scheduling between accounts and FIFO within each account. Default to two unassigned
warm worker slots and a maximum of 25 allocated browsers, with a total pod cap of 27 including
warm capacity. Warm workers launch a customer browser only after assignment. Replenish spare
capacity as resources permit; queue excess work with a visible reason.

Karpenter provisions EC2 nodes for unschedulable browser pods and removes idle nodes. Keep
the controller and baseline services on a small managed node group. Use On-Demand browser
nodes initially and bound the NodePool's resources. HPA can scale stateless services; it
must not arbitrarily remove individual active browser sessions.
See [EKS autoscaling](https://docs.aws.amazon.com/eks/latest/userguide/autoscaling.html).

Retire only unassigned slots during fleet scale-in. Protect active pods from voluntary
disruption and use drain-aware upgrades; forced termination or node loss still follows
lease recovery. Profile persistence does not make live browser processes migratable.
Ship metrics for allocation latency, queue age, active/warm browsers, lease failures, model
usage, credit reservations, stream lag, recording gaps, and solver outcomes.

## 12. Local development and local staging

Keep Docker Compose as the fast developer environment for Postgres, MinIO, engine, web,
and a fixed Camoufox worker once implemented. Production-like acceptance runs in a dedicated
kind cluster using the same Helm chart, images, RPC interfaces, and fleet controller as EKS.
The lifecycle commands exist; their complete deterministic and live acceptance journeys
remain incomplete. `staging:test:live` fails explicitly until the full journey is available.

| Concern | Local staging | AWS deployment |
| --- | --- | --- |
| Kubernetes | kind: one control-plane and two worker nodes | EKS with managed baseline nodes and Karpenter |
| Browser capacity | One warm slot, three allocated browsers, four total pods | Two warm slots, 25 allocated browsers, 27 total pods |
| Durable data | Postgres and MinIO with host-backed staging storage | RDS and S3 |
| Encryption | Dedicated persistent development wrapping key | KMS-backed wrapping |
| Authentication | Clerk development instance; fixture identity only in test mode | Clerk production instance |
| Payments | Paddle sandbox; signed webhook fixtures for automated tests | Paddle live environment |
| Models/solvers/proxies | Deterministic adapters and fixture proxy by default; explicit live smoke mode | Configured account/platform credentials |
| External callbacks | Optional HTTPS tunnel to the local gateway | Public HTTPS ingress |
| Telemetry | Optional local OTEL/LGTM stack | Centralized production telemetry |

Use an isolated kubeconfig, namespace, database, bucket prefix, key material, and provider
credentials. Local staging must not connect to an existing developer database or production
services. Use a NetworkPolicy-capable CNI in kind so tenant and egress tests actually enforce
the same restrictions as production. Fixture-site access is enabled only in local values.

Add lifecycle scripts exposed as `pnpm staging:up`, `staging:down`, `staging:reset`,
`staging:test`, and `staging:test:live`. Up checks prerequisites, builds/loads pinned images,
creates the cluster, installs the chart, runs migrations, and checks readiness. Down preserves
host-backed state; reset explicitly deletes only staging state. Test mode seeds two isolated
fixture accounts, sample workflows, and test credits without external charges. Hosted
configurations must reject fixture-auth and synthetic-credit settings.

Live smoke mode uses real Camoufox, a Clerk development instance, Paddle sandbox checkout,
and an HTTPS tunnel for signed callbacks. Real model, proxy, and solver calls require
explicit live-test credentials and finite budgets; no ordinary staging boot starts paid calls.
A real solver smoke uses supported provider test/demo challenges. Test signup, top-up, model
selection, workflow execution, takeover, replay, and profile reuse end to end.

Local tests exercise pod creation, queueing beyond three browsers, profile contention,
worker/engine restarts, controller reconciliation, idle scale-in, and persistence across
redeployment. Node count is fixed locally: kind cannot validate EC2 provisioning, IAM,
KMS, AWS network behavior, or 25-browser production capacity. Validate those separately in
an isolated AWS staging environment before production. See [kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/).

## 13. Migration and later optimization

Preserve existing workflows, versions, runs, store data, and historical traces. Backfill them
into an explicitly selected owner account; migrate ownership before enabling hosted access.
Drain old executions before switching routing semantics, then require execution identity on
new work. Keep historical approval outcomes readable as audit data while retiring their
runtime tables/APIs through an additive-then-cleanup migration. Do not modify applied migrations.

Existing CDP endpoints are a legacy migration path and development fixture, not the hosted
default. Browser-profile setup is required to establish fresh hosted logins; do not imply a
Chromium profile can be copied directly into Camoufox. Refresh technical/API documentation
and tests as each runtime transition lands.

The later Graph Optimizer observes operational evidence and emits a typed Graph Patch IR
against a base version. It never performs workflow work or writes runtime graph rows itself.
Candidates may split/merge tasks, reroute events, or migrate store tables. Deterministic
validation and publication apply the patch to a new version; active executions remain pinned.
Browser healing and trace recompilation ship before autonomous graph optimization.
