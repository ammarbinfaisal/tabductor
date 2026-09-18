# Tabductor business research: where to outshine Browserbase

Research date: 2026-09-18

This document identifies use cases in which Tabductor can create a stronger customer outcome
than Browserbase. It is a product and go-to-market thesis, not a claim that every described
capability is generally available today. Delivery status is tied to the
[implementation phases](impl-phases.md) and the target behavior is defined in the
[technical plan](techical_plan.md).

## Executive thesis

Tabductor's use-case scope is any browser automation that needs to run on a cron or recurring
schedule. A job may check one page, click one button, submit a form, perform a sequential
routine, collect a report, monitor a condition, reconcile accounts, or stream thousands of
records between systems. It may use a public page or an authenticated application. Neither
item discovery, multiple systems, large batches, nor a login is required to qualify.

Tabductor's best position is:

> Describe what your browser should do and when. Tabductor runs it on schedule, verifies the
> result, handles interruptions, and learns a cheaper, reliable path for repeated work.

The unit of value is a verified scheduled outcome: a daily check completed, a weekly form
submitted, a report refreshed, a setting updated, a reconciled transaction, or a synchronized
record. A successful run that finds no change or correctly takes no action is also valuable.

The opportunity starts with repetition. Differentiation becomes stronger when a job has one
or more of these needs:

- the user wants to describe a recurring task without maintaining scripts and infrastructure;
- a missed, late, overlapping, or duplicated occurrence creates work or loss;
- browser state, login, UI changes, or transient failures make unattended execution difficult;
- the same routine runs often enough for AI-to-script compilation to reduce cost;
- the buyer needs run history, verified outcomes, recovery, and predictable spending; or
- the job benefits from branching, parallel work, durable decisions, or incremental records.

Browserbase already offers scheduling through
[Director](https://www.browserbase.com/director). Scheduling is therefore a core customer
requirement, with the competitive opportunity in how easily users create, maintain, recover,
and operate recurring jobs. The rankings below prioritize where to prove that advantage;
they do not restrict the product to those segments.

## Competitive reality

Browserbase is a formidable adjacent competitor, not a straw man. Current product evidence
shows:

- [Browserbase Agents](https://docs.browserbase.com/platform/agents/how-it-works) accept a
  natural-language goal, run asynchronously, provide structured results, and expose live
  progress, replay, logs, files, search, fetch, and shell tools.
- [Director](https://www.browserbase.com/director) provides prompt-based workflow creation,
  scheduling and triggering, and exportable Stagehand code.
- [Stagehand](https://www.browserbase.com/stagehand/) combines natural-language actions and
  extraction with deterministic browser code in TypeScript and Python.
- [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts) persist
  authenticated browser state. Browserbase also documents
  [manual authentication and remote control](https://docs.browserbase.com/platform/identity/authentication),
  [Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view),
  and [Session Replay](https://docs.browserbase.com/platform/browser/observability/session-replay).
- Browserbase documents [Temporal integration](https://docs.browserbase.com/integrations/temporal/quickstart)
  for retries and failure recovery. A determined engineering team can assemble durable
  workflows around Browserbase.
- Its [pricing and capacity ladder](https://www.browserbase.com/pricing) makes it easy to
  start small and scale browser concurrency without building a fleet.

Accordingly, Tabductor wins only if it removes operational glue or produces materially better
economics and correctness across recurring browser jobs. A cron trigger alone does not
establish superiority over Browserbase.

## The remaining customer pains

The following are documented product boundaries or reasoned implications of current product
behavior. They should be validated in customer interviews rather than presented as universal
Browserbase defects.

| Pain | Evidence and interpretation | Customer consequence | Tabductor gain |
| --- | --- | --- | --- |
| A recurring job needs more than a timer | [Director already supports daily and weekly schedules](https://www.browserbase.com/director). Our hypothesis is that the harder recurring costs are maintaining the automation, handling failed occurrences, and verifying results. | Even a one-page job needs an owner when login expires, a form changes, or an occurrence is missed. | Intent authoring, scheduled execution, run history, recovery, and guarded compilation in one experience; compare maintenance effort across repeated occurrences. |
| A run is not a complete multi-stage business process | A Browserbase Agent run is one task on one dedicated session and ends in a terminal result. Browserbase supports progress messages, but [custom Agent tools are not yet supported](https://docs.browserbase.com/platform/agents/how-it-works). | Teams still connect agent results to databases, decision logic, other sessions, queues, retries, and exception handling. | A versioned browser/decision graph owns the whole operation and exposes only workflow-level APIs. |
| Incremental results need application orchestration | Agent progress can be polled while active, but the documented contract centers on a terminal structured result. This does not prevent a custom solution; it makes per-record fan-out an application concern. | A long source scan delays useful downstream work, or engineers build streaming consumers and checkpoints themselves. | Every discovered record is a durable event. Independent consumers can transform, store, or act on it while the source continues browsing. |
| Durability is available, but compositional | Browserbase's [Temporal quickstart](https://docs.browserbase.com/integrations/temporal/quickstart) requires a Temporal server, workers, workflow/activity definitions, monitoring, and separate credentials. | Customers own another orchestration layer and must align its retry semantics with browser side effects. | Execution identity, version pinning, outbox publication, leases, cancellation, dedupe, and uncertain-outcome recovery are one managed contract. |
| Optimization still contains a manual productionization step | [Optimize](https://docs.browserbase.com/platform/agents/optimizing-agents) proposes prompt changes that a user reviews and re-runs. Its [script generator](https://docs.browserbase.com/platform/agents/generating-scripts) produces a Stagehand starting point that must be reviewed and tested. | Successful exploratory behavior does not automatically become the production fast path. Teams choose between recurring model cost and maintaining generated code. | Tabductor's target loop promotes validated traces into guarded scripts, falls back to AI on guard failure, and demotes unhealthy artifacts automatically. |
| Persistent authentication has real lifecycle hazards | Browserbase advises against simultaneous logins with the same context and notes that sites can revoke or expire authentication in its [context guidance](https://docs.browserbase.com/platform/browser/core-features/contexts). | Competing runs can invalidate sessions; reauthentication becomes an operational queue. | Exclusive profile leases, generations, fair queuing, clean snapshots, and an explicit profile-setup/recovery flow make profile lifecycle part of the workflow system. |
| Human intervention can be more than remote mouse access | Browserbase already provides authenticated Live View and control, so “we have HITL” is not a differentiator. The harder problem is coordinating a takeover with durable task state and side-effect safety. | A human can solve MFA yet leave the agent with stale perception, duplicated actions, or an unclear resume point unless the application coordinates it. | The target design pauses at a command boundary, fences the old input owner, resumes with fresh perception, preserves committed descendants, and marks private recording intervals. |
| Infrastructure usage is not the same as operation economics | Browserbase's [usage tracking](https://docs.browserbase.com/optimizations/cost/measuring-usage) reports sessions, browser minutes, proxy traffic, duration, and status. | A vertical SaaS or operations team still maps infrastructure consumption to customer, workflow, record, and successful outcome. | A single operation ledger attributes browser, model, proxy, solver, reservation, adjustment, and reconciliation costs to an account and execution. |
| Long-lived work must be split and resumed | A Browserbase [browser session has a six-hour maximum](https://docs.browserbase.com/platform/browser/long-sessions/timeouts). The limit is reasonable for a browser lifetime, but some business processes last days because of queues or human gates. | Treating the session as the workflow lifetime creates fragile long-running sessions or bespoke checkpoints. | Tabductor separates durable execution lifetime from finite browser-session lifetime and can restore a profile into a later session. |

### A common asynchronous harness for every job shape

The graph remains asynchronous whether a scheduled job performs one action or processes a
large collection. Events can represent a schedule occurrence, a completed step, a condition,
an exception, or a discovered item. An automation does not need a source-to-sink data pipeline
to use this model.

| Job shape | Example | Execution behavior |
| --- | --- | --- |
| Single action | Set a portal's availability every weekday morning | A schedule starts a browser task that performs and verifies the action. |
| Sequential routine | Open a dashboard, select the reporting period, refresh, and check completion | Necessary browser actions remain ordered; completion can trigger another task asynchronously. |
| Conditional check | Check one product page hourly and act only when availability changes | A browser observation feeds a decision; an unchanged result completes without further action. |
| Independent parallel work | Check several sites every morning | Separate profiles can run independently; shared browser input remains serialized. |
| Incremental processing | Read timelines or portal records and update another system | Emit complete items as discovered so downstream work proceeds while collection continues. |

System prompts and compilation gates must choose the shape required by the intent. Preserve
necessary ordering, trigger independent consumers through events, and keep browser work
separate from durable store decisions. Emit incremental results promptly when there are
results to stream; use explicit aggregation when the outcome requires the whole collection.
Never require artificial item extraction or extra graph stages for a simple scheduled action.

Progress, retries, cancellation, and human communication retain asynchronous lifecycle
semantics. Execution completion accounts for all outstanding descendants and deliveries.
Browserbase also supports asynchronous runs; the proposed advantage is the integrated
execution and recovery contract across these job shapes.

### Scheduled browser automation use cases

These are proposed customer scenarios to validate, not claims of shipped vertical packages.
Cadences are illustrative and configurable; outcomes stay within browser and workflow-store
capabilities unless an additional integration is explicitly built.

| Use case | Example cadence | Existing pain to validate | Gain we aim to provide |
| --- | --- | --- | --- |
| Recurring form submission | Weekly | Someone repeats the same form and checks whether submission succeeded. | Reuse a published routine, fill current values, and verify confirmation each occurrence. |
| Scheduled setting or availability changes | Every weekday at opening and closing | A forgotten toggle leaves hours, availability, or campaign settings wrong. | Perform a small timed action and verify the resulting state, with visible failures. |
| Dashboard refresh and snapshot | Every morning | A person logs in, selects a period, refreshes a report, and copies totals. | Repeat the sequence and retain structured results and run evidence. File processing is a separate capability. |
| Price, stock, or appointment checks | Every hour | Repeated manual checks are easy to miss even when only one page matters. | Check on schedule, remember prior state, and run a configured branch when conditions change. |
| Website and application health checks | Every few minutes | A reachable homepage does not prove that login or a key user journey works. | Exercise the browser journey on schedule and record its outcome; broad cross-browser testing remains a separate product. |
| Scheduled content publication or updates | Weekly or daily | Publishing and updating web content requires repetitive timed UI work. | Execute the configured publishing routine and verify the visible result. |
| Portal housekeeping | Nightly | Stale drafts, expired entries, and outdated settings accumulate. | Apply the defined maintenance routine with bounded work and a result history. |
| Scheduled registration or renewal checks | Weekly or monthly | Deadlines and status changes are tracked by repeatedly visiting portals. | Recheck status and perform the configured next step or surface an exception. |
| Recurring browser-based data collection | Daily | Public or authenticated pages need revisiting, even for a single value. | Save observations over time and verify each collection occurrence. |
| Cross-system synchronization | Hourly or nightly | Systems without usable integrations drift apart. | Normalize and update records, streaming them when useful and preserving partial progress. |
| Account or settlement reconciliation | Daily or monthly | Balances and adjustments require repeated comparison and exception review. | Retain evidence and match refunds, credits, chargebacks, and partial adjustments. |

Scheduled checks and single actions are first-class use cases even when they have no
downstream consumer, no discovered records, and no authenticated profile.

## Ranked use-case portfolio

Ranking weighs recurring maintenance effort, pain intensity, repeat frequency, willingness to
pay, and potential advantage over Browserbase. It is a strategic priority, not measured market
share or an eligibility rule. Simple scheduled jobs belong in the product from the outset.

### Tier A: beachhead use cases

| Rank | Use case | Likely buyer | Existing pain | Gain from Tabductor | Winning condition |
| --- | --- | --- | --- | --- | --- |
| 1 | Recurring browser routines, including single actions and sequential jobs | Individuals, small teams, operations managers, agencies | Someone must remember each occurrence, maintain a script, and notice when it fails. A job may involve only one form, setting, or check. | Describe the routine and schedule once; inspect outcomes, recover exceptions, and reuse guarded execution over repeated runs. | Beat Director on measured setup time, maintenance effort, verified scheduled completion, or cost per successful occurrence. |
| 2 | Recurring authenticated monitoring followed by targeted action | Marketplace operators, procurement, property management, account operations | A watcher must revisit logged-in portals, detect meaningful changes, remember prior state, and update another system or take action. | Persistent profiles plus workflow state distinguish “new” from “already handled”; schedules create version-pinned executions; only changed items fan out. | Win on reliable change detection, bounded spend, and recovery across repeated runs—not raw public-web scraping. |
| 3 | High-volume repetitive portal operations | Operations teams handling orders, returns, claims, applications, or account changes | Pure agents repeatedly pay perception/reasoning cost; deterministic scripts break when the UI changes. | AI explores first, successful traces become guarded scripts, and guard failures deopt to AI in the same session. | Prove a sustained reduction in cost per successful operation without reducing completion rate. |
| 4 | Exception-heavy work with login, MFA, CAPTCHA, or ambiguous site state | BPOs, managed-service providers, internal operations teams | Human takeover often sits outside the run's state machine; resumption can repeat a side effect or lose context. | One input owner, command-boundary pause, private intervention interval, fresh-perception resume, and durable exception queues. | Prove safe pause/resume under races and show that an operator can manage many workflows by exception. |
| 5 | Reconciliation across portals and an internal book of record | Finance operations, marketplace settlements, subscription or commerce platforms | Partial refunds, credits, chargebacks, fees, and out-of-order changes make “scrape a total” insufficient. Teams need evidence, matching rules, adjustments, and unresolved cases. | Event-sourced adjustments, idempotent ingestion, partial-refund accounting, durable matching decisions, and a review path for uncertain external outcomes. | Start with non-custodial read/reconcile workflows; demonstrate exact ledger invariants and auditable differences before automating monetary actions. |
| 6 | Recurring synchronization and bulk migration between systems without usable APIs | Vertical SaaS vendors, implementation firms, RevOps/Recruiting Ops | Source records must be normalized, deduplicated, written, retried, and audited. A monolithic run loses partial progress. | Records flow downstream as discovered; execution resumes from durable state; per-record failures follow an exception path. | Demonstrate lower operator minutes and fewer duplicate or missing records than an agent-plus-custom-queue implementation. |

Use case 5 is especially aligned with the current payment-ledger work, but it is high trust.
The initial product should reconcile and surface exceptions before it initiates irreversible
financial actions.

### Tier B: vertical packages built on the same paradigm

| Use case | Workflow shape | Why Tabductor can be better | Principal risk |
| --- | --- | --- | --- |
| Marketplace listing and inventory operations | Read seller portal items, normalize per item, compare with catalog state, update changed listings, capture confirmations. | Incremental fan-out, authenticated profiles, item-level idempotency, and compilation for repeated forms. | Portals may prohibit automation or present sophisticated defenses. |
| Recruiting operations and ATS migration | Discover candidates/applications, map fields, dedupe, create/update records, route incomplete cases. | Large batches benefit from streaming and resumability; human review naturally becomes an exception consumer. | Sensitive personal data requires strong retention, access, and audit controls. |
| Vendor, license, and registry monitoring | Visit authenticated registries, emit each entity, compare against last known state, preserve evidence, alert or update. | Versioned decisions and evidence can be tied to the exact workflow event rather than only a browser recording. | Public Search/Fetch may be cheaper when authentication and action are unnecessary. |
| Property and field-service portal coordination | Read work orders across portals, normalize them, schedule/update records, and confirm completion. | Many heterogeneous authenticated systems, recurring work, and frequent human exceptions match the profile/event model. | Buyers may need mobile and communications integrations outside the first product boundary. |
| Order, return, and supplier-portal operations | Process each order independently while the source browser continues paging; update ERP or another portal; reconcile confirmations. | Work continues after individual record failure, duplicate actions are fenced, and costs attach to an order/execution. | External API or EDI integrations remain preferable when available. |
| Evidence collection for audit or due diligence | Gather state from multiple authenticated sources, transform structured evidence, and record provenance. | Event lineage, version pinning, timeline alignment, and durable stores create a stronger audit package than a terminal answer. | A browser replay alone is not legal proof; retention and evidentiary requirements vary. |

### Tier C: platform and ecosystem opportunity

Vertical software companies can embed Tabductor as the “last-mile operations” layer behind
their product. They publish and trigger a workflow through a small workflow-level API rather
than exposing browser sessions, task IDs, queue topology, or Playwright code to customers.
This is commercially attractive because the software vendor can sell an outcome while
Tabductor absorbs browser lifecycle and recovery complexity.

The embedded case becomes compelling only after tenancy, billing, isolation, observability,
and service reliability are proven. It is not the first design-partner motion.

## Infrastructure products outside the initial focus

Tabductor should deliberately avoid early head-to-head competition in areas where Browserbase
has a structural lead or where Tabductor's architecture is intentionally narrower:

- commodity Playwright/Puppeteer/Selenium browser sessions;
- a standalone public-web Search/Fetch API;
- one-shot autonomous research agents that need files and shell tools;
- arbitrary hosted functions or customer Python;
- a comprehensive cross-browser testing grid or Chrome-extension runtime;
- maximum global browser concurrency before the fleet is proven;
- a general model gateway.

Recurring public-page extraction, single-page checks, and scheduled browser smoke tests remain
in scope. Authentication, batch size, and number of steps do not determine product fit. Where
a supported API exists, compare its economics and reliability with browser execution rather
than excluding the customer's recurring task from the use-case portfolio.

The [technical plan](techical_plan.md) intentionally defers Search/Fetch, arbitrary hosted
functions, public browser connections, and a general model gateway. That focus is a business
advantage only if creating and operating recurring browser jobs is substantially easier.

## Customer gains and how to measure them

Avoid ROI claims based only on browser-hour price. Measure the full operation.

| Gain | Primary metric | Test method |
| --- | --- | --- |
| Reliable scheduled outcomes | Expected schedule occurrences with one verified outcome by the required deadline, divided by all expected occurrences | Count missing, late, failed, and duplicated outcomes as failures; test overlap policy, timezone boundaries, downtime, and slow runs. |
| Lower maintenance burden | Operator and engineering minutes per active scheduled job per month | Run simple and complex jobs repeatedly through UI changes, expired sessions, and transient failures. |
| Faster time to a working automation | Median elapsed time from approved intent to first successful production-like execution | Give the same scoped workflow to a Tabductor user and a Browserbase/Stagehand implementation team. Include orchestration and destination writes. |
| Earlier useful output where streaming applies | Time to first accepted record and records completed while source discovery remains active | Run a paginated source with intentionally slow browsing and independent downstream consumers. |
| Better recovery | Percentage of injected failures recovered without lost progress or duplicate side effect | Kill workers before/after emit, during navigation, and around an ambiguous submit; verify store and external counters. |
| Lower steady-state cost | Total browser, model, proxy, solver, and operator cost per successful operation | Compare initial AI mode with promoted guarded execution over a representative run set. Include fallback costs. |
| Less human effort | Operator minutes and interventions per 100 completed operations | Track takeover, review, retry, reauthentication, and manual reconciliation separately. |
| Higher process accuracy | Missing, duplicate, incorrectly mapped, and unresolved records per 1,000 inputs | Reconcile against a fixture truth set and a sampled real-world set. |
| Better spend control | Percentage of chargeable operations attributed and reconciled to account, execution, purpose, and rate version | Reconcile the usage ledger against provider reports and browser intervals. |
| Safer iteration | Executions whose descendants remain on the originally published version | Publish a graph revision during active work and prove no cross-version routing. |

A practical customer ROI model is:

`value = labor avoided + integration engineering avoided + prevented rework/loss - platform usage - exception labor`

The proof metric should usually be **cost per verified successful operation**, not cost per
browser hour or nominal agent completion rate.

## Product readiness: claims now versus claims after delivery

### Evidence-backed foundation today

The repository currently contains the foundations for an event bus and durable queue,
event-centric graph execution, versioned workflow APIs, browser and decision task separation,
workflow-store operations, guarded static execution, trace compilation, and workflow-level
MCP operations. Recent work also strengthens asynchronous graph streaming and payment-event
reconciliation.

Safe present-tense language:

- “Tabductor is built around typed events and independent consumers.”
- “The architecture separates browser interaction from durable decisions and storage.”
- “The execution foundation supports incremental emission rather than one terminal batch.”
- “The compiler can derive guarded browser scripts from successful traces.”

These are engineering foundations, not yet proof of a production hosted service.

### Claims gated by the hosted roadmap

The following should remain future-tense until their acceptance gates pass:

| Claim | Required phase |
| --- | --- |
| Reproducible local hosted environment | H0 |
| Secure multi-tenant accounts and ownership | H1 |
| Workflow-wide execution identity, version pinning, fencing, and complete atomicity | H2 |
| Managed Camoufox browsers and persistent profile leasing | H3 |
| Live viewing, private playback intervals, and safe takeover/resume | H4 |
| Complete BYO/platform model attribution and automatic artifact lifecycle | H5 |
| Prepaid credits, reservations, refunds, chargebacks, and usage reconciliation | H6 |
| Managed proxies and challenge recovery | H7 |
| Production-like AWS capacity, isolation, recovery, and operations | H8 |

No sales material should imply that Camoufox, hosted tenancy, playback, managed billing, or
AWS fleet capacity is live merely because it is designed.

## Go-to-market recommendation

### Initial ideal customer profile

The addressable user includes an individual with one recurring browser task, a small team
with several routines, and an enterprise with many workflows. For design-partner selection,
prioritize measurable recurring pain:

- an hourly, daily, weekly, or monthly browser routine someone currently owns;
- recurring manual effort or script maintenance whose cost can justify automation;
- meaningful consequences when an occurrence is missed or its result is wrong;
- observable completion criteria, including valid “no change” outcomes; and
- enough repetition to demonstrate compilation economics within weeks.

Large record counts, multiple operators, authentication, and unavailable APIs can strengthen
the business case, but they are not prerequisites.

Implementation consultancies, vertical SaaS vendors, marketplace operators, recruiting
operations, and property/vendor operations are stronger first prospects than highly regulated
financial or healthcare workflows. They provide the same technical stress without making
certification and liability the first blocker.

### Beachhead offer

Lead with the recurring job:

> Tell us what you do in the browser and when it should happen. We run it on schedule, show
> whether it succeeded, and help it recover when the website or session changes.

Start with a paid design-partner engagement and a fixed success definition. Do not lead with
the graph, Camoufox, Kubernetes, or MCP. Those are mechanisms. Lead with recovered operator
hours, lower error/rework, and throughput per operator.

### Discovery questions

1. What browser task do you repeat, on what schedule, and who owns it today?
2. What counts as success, and what does a missed, late, or duplicated occurrence cost?
3. Which actions are unsafe to repeat after a timeout or lost connection?
4. How are logins, MFA, and expired sessions handled today?
5. What percentage of cases need a human, and can the human resume rather than restart?
6. What is the loaded cost per successful occurrence, including engineering and exception labor?
7. How often does a stable process change enough to break scripts?
8. For jobs with many records, how is partial progress recovered and correctness checked?

## Product priorities implied by this research

1. Make recurring execution a first-class product experience: intent, cron/timezone, enable or
   disable, occurrence history, and verified results. Specify overlap, missed-occurrence, and
   retry policies, and validate them before claiming production scheduling reliability.
2. Finish H2 before broadening connectors. Version pinning, atomic emit/store behavior,
   fencing, and uncertain-outcome handling are the basis of the business claim.
3. Preserve the asynchronous harness across single-action, sequential, conditional, parallel,
   and streaming jobs. Prompts and compilation should select the appropriate shape; validate
   both a simple cron action and a source-to-many-consumers workflow under failure and recovery.
4. Make the AI-to-guarded-script lifecycle automatic and measurable. This is the clearest
   potential economic advantage over Browserbase's current advisory/manual optimization path.
5. Build profile leases and workflow-aware takeover as an operational system, not merely a
   remote browser viewer.
6. Finish the account/execution usage ledger and adjustment reconciliation so price and margin
   can be understood at the completed-operation level.
7. Package one vertical workflow only after the generic event contract passes; avoid adding
   product-specific shortcuts to the harness.

## Risks and likely competitive response

- **Browserbase can close the gap.** It is shipping quickly and could add custom Agent tools,
  automatic script promotion, deeper orchestration, or richer business-level metering.
  Tabductor must win through an integrated operating model and vertical proof, not a checklist.
- **Camoufox is a thesis, not a guaranteed moat.** Camoufox describes native anti-detection
  techniques, but its own [stealth status](https://camoufox.com/stealth/) acknowledges a past
  maintenance gap and fingerprint inconsistencies. Firefox compatibility and detection rates
  need a representative bake-off before making superiority claims.
- **Scope can overwhelm the wedge.** Fleet management, auth, billing, proxying, CAPTCHA,
  recording, orchestration, and AI compilation are each substantial products. The first
  customer workflow must validate the combined value before all platform breadth is built.
- **Web automation has policy and reliability limits.** Terms of service, data rights,
  robots/anti-bot controls, privacy, and regulated information differ by site and use case.
  Technical ability is not authorization.
- **Exactly-once website effects are impossible in general.** Tabductor can make its own
  commits idempotent and record intent/outcome, but a disconnected external submit can remain
  uncertain. Honest recovery semantics are stronger than an impossible exactly-once promise.
- **APIs remain the right answer when available.** Browser automation should be sold for the
  inaccessible last mile, not as a replacement for reliable supported integrations.

## Decision

Tabductor serves browser automation that needs to run on a schedule. The commercial promise
is less effort to create, maintain, and trust those recurring jobs, from a single timed action
to a complex asynchronous workflow.

Validate that promise with a small portfolio: a single scheduled action, a sequential browser
routine, a conditional monitor, and an incremental synchronization job. Measure verified
scheduled completion, maintenance time, recovery behavior, and cost per successful occurrence
against Browserbase. Streaming is an important capability within that portfolio; the product
scope is the full range of schedulable browser automation.

## Primary research sources

- [Browserbase pricing and platform packaging](https://www.browserbase.com/pricing)
- [Browserbase Agents: how it works](https://docs.browserbase.com/platform/agents/how-it-works)
- [Browserbase Agent optimization](https://docs.browserbase.com/platform/agents/optimizing-agents)
- [Browserbase Agent script generation](https://docs.browserbase.com/platform/agents/generating-scripts)
- [Browserbase contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
- [Browserbase authentication](https://docs.browserbase.com/platform/identity/authentication)
- [Browserbase usage tracking](https://docs.browserbase.com/optimizations/cost/measuring-usage)
- [Browserbase Temporal integration](https://docs.browserbase.com/integrations/temporal/quickstart)
- [Browserbase session timeouts](https://docs.browserbase.com/platform/browser/long-sessions/timeouts)
- [Camoufox stealth overview and maintenance status](https://camoufox.com/stealth/)
