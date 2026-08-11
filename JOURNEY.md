# JOURNEY.md

<!-- The structural and temporal design spec for Tabductor. Pairs with DESIGN.md (visual tokens — to come; for visual tokens, see DESIGN.md once locked). -->
<!-- Method: journey doctrine (JTBD → map → IA → flows → page specs; NN/g, Rosenfeld/Morville) + ai-native doctrine (agent-UX framing of the publish compiler). -->

## Job

**Job story (author):** When I have a browsing/automation task I can describe in plain language but can't babysit — "watch this timeline, rank what appears, decide what to chase next" — I want to write prompts for nodes and descriptions for the events that connect them, and have the system compile and run the workflow, so I can watch real packets flow within minutes and evolve the workflow by editing prose, never JSON.

**Job story (viewer):** When someone sends me a link to a running workflow, I want to watch its graph, runs, and opted-in event data live without an account, so I can see the thing working without being able to touch it or read what wasn't shared.

**Functional job:** author a working event-driven agent workflow through prompts alone; publish it; observe and iterate on it; expose a curated live view of it.
**Emotional job:** feel in control of an LLM-compiled system — the author can always see what their prose produced (the compiled schema, the compile report) and always has a deterministic lever (Trigger now, stub packets, republish).
**Social job:** look competent in front of whoever holds the share link — the public view shows a live, legible system, never a broken or oversharing one.

**Switch interview (Moesta four forces):**
- **Push:** hand-rolled automation scripts and canvas workflow tools demand JSON schemas, drawn edges, and code; every contract change means editing structures by hand, and wiring drift breaks silently.
- **Pull:** prose is the only input. Topology is derived from type declarations; schemas are compiled from descriptions; a just-published graph runs immediately on sampled stub packets.
- **Anxiety:** "an LLM writes my schemas — will it produce the contract I meant, and how do I fix it when it doesn't?" (Answered by design: read-only field-list schema display, per-event compile report, atomic publish failure, edit-and-republish repair loop.)
- **Habit:** the canvas mental model — wanting to draw the arrow. (Answered by the derived Map: the arrows still exist, they're just read-only evidence of the declarations, not an editing surface.)

**JTBD school used:** Moesta (Switch interview / four forces). No other school's vocabulary is used in this document.

---

## Journey

**Actor:** the builder — a technical author writing scraping/automation workflows on their own local install. (Secondary actor, mapped where it diverges: the share-link viewer.)
**Scenario:** author the canonical tweet-scraping workflow — a Timeline scraper node emitting `tweet.detected`, a Ranker node emitting `tweet.ranked`, a Curator node closing a decision loop with `scrape.requested` — publish it, watch it run, evolve it, and share a live view.
**Scope:** future-state; touchpoints are the six product surfaces only (no marketing site, no email, no auth — none exist).

| Phase | Actions | Mindset | Emotion | Touchpoints | Opportunities |
|-------|---------|---------|---------|-------------|---------------|
| Orient | Open `/workflows`, scan names + last-run status, open or create a workflow | "Where did I leave off? Is anything failing?" | Med | Workflow list | Last-run status on the card makes the list a health dashboard, not a directory |
| Author | In the editor: write event descriptions (`tweet.detected`: "A tweet found on the timeline: its text, author handle, permalink URL, and when it was posted"), write node prompts, toggle trigger/emit chips | "I'm describing what I want, not wiring it" | High | Editor (Events + Nodes panels) | The derived Map updates as chips toggle — instant proof the declarations connect |
| Publish (compile) | Hit Publish; LLM compiles each changed event description into a schema; deterministic gate checks; per-event compile report returns | "Did my prose produce the right contract?" | **Valley risk** | Editor (compile report, error banners) | The make-or-break moment — see the dedicated repair flow below (this is a first-class journey step, not an edge case) |
| Repair (when compile fails) | Read the failed event's error, edit that description, republish; unchanged events are carried forward free | "The report tells me exactly which event and why" | Low → recovering | Editor | Error banner keyed to the offending event card; failure is atomic so nothing half-published |
| Watch | Stub engine emits sampled packets from compiled schemas; open Runs and the Event feed; inspect packets and lineage; "Trigger now" a node | "It's alive — and I wrote zero JSON" | **Peak** | Runs table, Event feed, Map | Peak-end rule (Kahneman): invest here — the first sampled `tweet.detected` packet appearing is the product's payoff moment |
| Evolve | Edit a node prompt or event description, republish (hash-matched events reuse schemas at zero cost), re-watch | "Iteration is cheap" | High | Editor, Runs, Events | The carry-forward hash makes the steady-state loop nearly free — surface "reused" in the compile report so the author sees it |
| Share | Open Share, create a link, review the visibility preview (public vs private events, emitters, schema fields), send the URL | "Exactly what am I exposing?" | Med, vigilant | Share management | The preview and the publish-time visibility diff are the trust surface — widening is always a deliberate, diffed act |
| (Viewer) Watch | Open `/s/<token>`: graph shape, runs, event feed; private packets withheld; poll-live at 2s | "I can see it working; some data is deliberately private" | Med | Public view | Withheld packets render as an honest "private" marker, never a gap that looks like a bug |

**Decision model:** McKinsey loyalty loop (2009). There is no acquisition funnel — the actor already owns the tool. The loop that matters is the post-purchase loyalty loop: Author → Publish → Watch → Evolve → Publish…, re-entered directly without re-evaluation. Design effort goes to loop friction (compile-report clarity, carry-forward cost, error-to-fix distance), not to persuasion. (No linear funnel — doctrine rule.)

**Emotion curve:** rises through Author (prose feels effortless), dips to its valley at Publish when a compile fails (the author is momentarily at the mercy of a model they steer only indirectly), recovers through Repair if the report is legible, peaks at Watch when sampled packets flow, and settles high through Evolve. The design's job is to make the valley shallow (per-event errors, atomicity, free retries) and the peak fast (stub packets require nothing hand-written).

**Research basis:** UNGROUNDED — single-user pre-production product; no interviews or diary studies exist. This map is a hypothesis derived from the product docs (`docs/event-centric-model.md`, `docs/sharing.md`) and must be revisited against real usage. Owner: the builder (repo owner). Update cadence: at each design-track phase gate. (Flagged per NN/g / Watermark 2023 journey-map-theater rule.)

---

## AI-native posture

The pages here are fixed, so journey mapping legitimately applies (ai-native orienting question A: fixed substrate → `journey` doctrine governs). The AI-native part is the **publish step**: the artifact being authored IS prompts, and the schema compiler is an LLM the author steers only through prose. Design consequences, applied throughout the flows and page specs below — all **principle-derived, no settled canon** (Dibia agent-UX principles; Smashing "Designing for AI Beyond Conversational" 2024):

1. **Goal contract:** publish takes prose (event descriptions + neighborhood node prompts) and returns either a compiled schema per event or a per-event failure. The UI states this contract: what the compiler read (the description), what it produced (the schema), what gate it passed (deterministic ajv check).
2. **Inspectability:** the compiled schema is always displayed as a **read-only field list** (name, type, format/enum, nesting one level) — never raw JSON — so the author can tell whether their prose produced the right contract at a glance.
3. **Failure and repair:** compile failure is a designed loop (flow F2), not an error toast. Atomic failure + per-event report + error banner keyed to the offending card = shortest possible error-to-fix distance.
4. **Deterministic exits:** "Trigger now", sampled stub packets, and the reused-schema carry-forward are always-available non-LLM paths; the author is never blocked on a model call to see the system move.
5. **Honest confidence:** compile statuses are exactly `generated | reused | failed` — the system never presents a generated schema as anything other than compiler output.

There is no chat or streaming surface; this is a document-editing product whose compiler happens to be a model. Conversational-UI patterns do not apply.

---

## IA

**Organization scheme:** task-based (Rosenfeld/Morville ambiguous scheme) — surfaces are named for what the author does there: edit, runs, events, share.
**Structure type:** hub-and-spoke per workflow. The editor (`/workflows/[id]`) is the hub; runs, events, and share are spokes reached from it; the workflow list is the index above the hubs. The public view is a parallel, disconnected mini-hub (`/s/<token>` → runs / events) — deliberately unlinked from the owner IA since viewers hold only the token.

**Sitemap:**
```
/workflows                      workflow list (index)
└── /workflows/[id]             THE EDITOR (hub)
    ├── /workflows/[id]/runs    runs table
    ├── /workflows/[id]/events  event feed (+ per-event detail w/ lineage)
    └── /workflows/[id]/share   share management

/s/[token]                      public view (parallel hub; token is the credential)
├── /s/[token]/runs             public runs (+ /runs/[ref] detail)
└── /s/[token]/events           public event feed
```

**Global navigation labels:** owner surfaces carry one persistent workflow-scoped tab bar: **Editor · Runs · Events · Share**, with the workflow name + version indicator as the section header and "Workflows" as the breadcrumb back to the index. Four labeled choices — grouped and staged per Hick's law (Hick–Hyman 1952); note visible-item count is not a memory constraint (Cowan ~4±1 governs working memory, not on-screen items).
**Navigation model:** global (Workflows index) + local (the four workflow tabs) + contextual (error banners deep-link to the offending event/node card; event detail links to its lineage; run row links to its emissions). Public view: local tabs only (**Overview · Runs · Events**), no global nav, no owner links.
**Labeling rule:** the word **publish** is reserved for compiling a version; the public-link feature is always **share** (`docs/sharing.md` §1 — two meanings of publish is a bug waiting to be written). Event types render in code style (`tweet.detected`); statuses use the fixed vocabulary `generated | reused | failed` and the bounded public error classes.

**Validation:** NOT VALIDATED — no card sort or tree test conducted (single-user product). Sitemap ≠ IA caveat acknowledged; labels above are hypotheses to revisit if outside users ever author workflows.

---

## Flows

Notation: entry ●, exit ◎, [action], <decision> (NN/g flow notation). Fitts's law (Fitts 1954) applied at every primary CTA; Hick's law at every decision node.

### F1 — Author and first-publish (task flow, happy path)
**Type:** task flow
**Entry:** ● `/workflows` → "New workflow" (or an existing draft)
**Goal:** go from empty workflow to a running graph with zero JSON.
**Steps:**
1. [Editor: add event `tweet.detected`; write its description prompt; leave public toggle off]
2. [Add events `tweet.ranked`, `scrape.requested` the same way]
3. [Nodes panel: add "Timeline scraper" (browser) — prompt: "Open the timeline, find new tweets, emit one tweet.detected per new tweet"; trigger chips: schedule `*/5 * * * *` + consumes `scrape.requested`; emit chip: `tweet.detected`]
4. [Add "Ranker" (asset) — consumes `tweet.detected`, emits `tweet.ranked`]
5. [Add "Curator" (browser) — consumes `tweet.ranked`, emits `scrape.requested`] — the Map now shows the cycle Curator → scrape.requested → Scraper → tweet.detected → Ranker → tweet.ranked → Curator, annotated with the loop-budget note
6. [Publish] → compile report: 3 events `generated`
7. ◎ Stub engine emits sampled packets; author lands in Watch (Runs / Event feed)
**Error states:** save-time gate rejects an emit chip naming an undeclared event (inline on the chip, before publish is even possible). Compile failure → flow F2.
**Success state:** version indicator increments; event feed shows sampled `tweet.detected` packets.

### F2 — Publish, fail, repair, republish (user flow) — the publish-failure path, first-class
**Type:** user flow (this is the journey's valley; it gets its own flow by design, per DW-4.2)
**Entry:** ● [Publish] from the editor
**Goal:** turn a failed compile into a successful version with the minimum error-to-fix distance.
**Steps:**
1. [Publish] → compiler runs per event (changed events only; hash-matched events reuse)
2. <All events compile?>
   - **yes** → [compile report renders: each event `generated` or `reused`] → step 5
3. **no** → [publish fails **atomically** — no rows written, current version unmoved]
   - [Compile report renders per event: e.g. `tweet.detected: generated`, `tweet.ranked: FAILED — "description does not determine a field type for 'score'"`, `scrape.requested: reused`]
   - [Error banner appears, keyed to the failed event; clicking it scrolls to and highlights the `tweet.ranked` event card, error text inline on the card]
   - [Author edits the description prose — e.g. adds "a relevance score as a number from 0 to 1"] — note: the fix is always prose; there is no JSON escape hatch
   - [Republish] → only the edited event recompiles (others carry forward free) → back to <2>
4. (Repeated failure) — the author keeps iterating on prose; each retry costs only the changed events. No retry limit in the UI; the bounded self-repair happens inside the compiler.
5. <Does this publish change what share links expose?> (any `public` flag or public schema changed)
   - **yes** → [visibility-diff confirmation: exactly which events/fields become visible or hidden] → <Confirm?> no → ◎ abort, nothing published / yes → step 6
   - **no** → step 6
6. ◎ Version published; version indicator updates; compile report remains readable (statuses per event) until dismissed
**Error states:** compiler/transport failure (not a schema failure) → banner "publish failed, nothing changed — retry"; the atomicity guarantee is stated in the banner copy.
**Success state:** new version live; every event card shows a compiled read-only field list; author can verify the repaired `tweet.ranked` schema now carries `score: number`.

### F3 — Evolve and observe (user flow, the loyalty loop in miniature)
**Type:** user flow
**Entry:** ● editor of a published workflow (arriving from the list's status column or after F1)
**Goal:** change behavior, verify cheaply.
**Steps:**
1. [Edit the Ranker's node prompt] — changes compiler *context* only; a badge on affected events notes "will recompile on next publish"
2. [Publish] → <hash changed per event?> only affected events pay; report shows `reused` for the rest → (F2 if any fail)
3. [Trigger now on Timeline scraper] → [open Runs: new run row with status/attempt/timing] → [open Events: new `tweet.detected` → `tweet.ranked` chain; open detail for lineage]
4. <Behavior right?> no → back to 1 / yes → ◎ done; the loop re-enters at will
**Error states:** run failure → status in Runs with full error text (owner view); cancel available on in-flight runs.
**Success state:** the author reads the event chain and confirms the change did what the prose said.

### F4 — Share a live view (user flow)
**Type:** user flow
**Entry:** ● Share tab of a published workflow
**Goal:** hand an outsider a live, read-only, correctly-scoped view.
**Steps:**
1. [Review visibility preview: public events (`tweet.detected`, `tweet.ranked` — with emitters and schema fields) vs private (`scrape.requested`)]
2. <Scope right?> no → [return to editor, toggle event `public` flags, republish (F2 step 5 shows the diff)] → back to 1
3. **yes** → [Create link] → [token shown **once**, with copy action and the "shown once — rotate to replace" note]
4. [Send URL] → viewer opens `/s/<token>`: graph shape, runs (bounded error classes only), event feed; `scrape.requested` packets withheld with an explicit private marker
5. (Later) <Link leaked or done?> → [Rotate] (new token, same share) or [Revoke] (immediate; viewers get an indistinguishable 404) → ◎
**Error states:** viewer with unknown/malformed/revoked token → identical 404 (never confirms a workflow existed).
**Success state:** viewer watches live (2s poll) seeing exactly the manifest, nothing more.

---

## Page specs

### Workflow list — `/workflows`
**Purpose:** answer "what do I have and is anything failing?" and route into a workflow's hub in one glance.
**Entry points:** app root; breadcrumb from any workflow surface.
**Content blocks (in order):**
1. Header — "Workflows" + primary CTA "New workflow".
2. Workflow cards/rows — name, task count, last-run status (the status chip is the health signal; failed runs make the row findable without opening it).
**States:**
- Default: rows sorted with most recently active first.
- Loading: skeleton rows.
- Empty: "No workflows yet" + New workflow CTA (Fitts: the only large target on the page).
- Error: load-failure banner with retry.
- Success: n/a (navigation page).
**Primary CTA:** "New workflow" → editor of the new workflow; each row → that workflow's editor.
**Exit / next:** `/workflows/[id]` (editor).

### The editor — `/workflows/[id]` (the core surface)
**Purpose:** author the entire workflow as declarations — event descriptions, node prompts, trigger/emit chips — and compile it via Publish, with every compiler outcome legible in place.
**Entry points:** workflow list row; the local tab bar from Runs/Events/Share; error-banner deep links.
**Content blocks (in order):**
1. Header — workflow name, **version indicator** (published version + draft-changes marker), primary CTA **Publish** (top-right, large, isolated per Fitts; disabled-with-reason when the save-time gate fails).
2. **Error banner region** — post-publish failures render here, one banner per failed event, each deep-linking to (scrolling/highlighting) the offending event or node card.
3. **Events panel** — one card per event entity: type name (`tweet.detected`), description-prompt textarea (prose only — no JSON input exists anywhere on this surface), "public in share links" toggle, **read-only compiled-schema display as a field list** (name · type · format/enum; one nesting level), and compile status chip (`generated | reused | failed` + inline error text when failed). "Add event" affordance at panel end.
4. **Nodes panel** — one card per node: kind badge (browser | asset), name, prompt textarea, **trigger chips** (cron schedule + consumed event types), **emit chips** (declared event types; adding one references declared events only — undeclared emits are rejected at save), mode/limits knobs, and **Trigger now** (secondary button, spatially separated from anything destructive per Fitts).
5. **Derived Map** — read-only, auto-laid-out nodes ↔ events bipartite visualization; updates as chips toggle; cycles annotated with the loop-budget note. Never an editing surface — wiring is toggling a type on a card, never drawing a line.
6. **Compile report** (post-publish overlay/section) — per event: `generated | reused | failed (+error)`, chunked per event card (Cowan ~4±1: report reads as a short scannable list, not a wall).
7. **Visibility-diff confirmation** (modal, conditional) — when a publish changes what share links expose: exact events/fields becoming visible or hidden; Confirm/Cancel, Cancel safe-default.
**States:**
- Default: three regions populated; draft edits marked against the version indicator.
- Loading: panel skeletons.
- Empty (new workflow): both panels show empty-state guidance ("Describe an event… / Add a node and tell it what to do"), Map empty; Publish disabled with reason.
- Error: (a) save-gate violations inline on the offending chip/card; (b) compile failure → banner region + per-card status, publish atomically rejected; (c) transport failure → "nothing changed — retry" banner.
- Success: compile report all `generated`/`reused`; version indicator increments; schemas refresh on event cards.
**Primary CTA:** "Publish" → compile → report (→ visibility diff when applicable).
**Exit / next:** Runs or Events tab (watch the graph move); Share tab (expose it).

### Runs — `/workflows/[id]/runs`
**Purpose:** show what executed and how it went, in time order, with control over in-flight work.
**Entry points:** editor tab bar; post-publish "watch it run" impulse; F3 step 3.
**Content blocks (in order):**
1. Runs table — status, task, attempt, started/ended, duration; full error text on failed rows (owner view); Cancel action on in-flight rows (separated from row navigation per Fitts).
2. Pagination (keyset) — historical scroll-back.
**States:**
- Default: newest first, polling live (2s).
- Loading: skeleton table.
- Empty: "No runs yet — Publish, wait for the schedule, or use Trigger now in the editor" (deep link back).
- Error: load banner with retry; failed runs are data, not an error state.
- Success: n/a (observation page).
**Primary CTA:** none primary; row → run context (its trigger, its emissions); Cancel is the destructive secondary.
**Exit / next:** event feed (follow a run's emissions); editor (fix what failed).

### Event feed — `/workflows/[id]/events`
**Purpose:** show the packet-level truth of the workflow — every event with its type, source, and payload, with lineage on detail.
**Entry points:** editor tab bar; runs table (a run's emissions); F3 verification step.
**Content blocks (in order):**
1. Feed rows — type (`tweet.detected`), source task, timestamp, packet preview.
2. Event detail (per row) — full packet rendered as a formatted field list/`<pre>` JSON (display-only), plus **lineage**: the causal chain of upstream/downstream events (depth-capped).
3. Pagination (keyset).
**States:**
- Default: newest first, polling live.
- Loading: skeleton rows.
- Empty: "No events yet" + pointer to Trigger now / schedule.
- Error: load banner with retry.
- Success: n/a.
**Primary CTA:** row → event detail with lineage.
**Exit / next:** editor (adjust the prose that produced a wrong packet) — this exit is the iterate edge of the loyalty loop.

### Share management — `/workflows/[id]/share`
**Purpose:** create, rotate, and revoke share links, and show exactly what a link exposes before and after it exists.
**Entry points:** editor tab bar; F4.
**Content blocks (in order):**
1. **Visibility preview** — public events with their emitters and schema fields (`tweet.detected` from Timeline scraper: text, author, url, posted_at) vs private events listed by type only (`scrape.requested` — packet never shown); the always-visible tier (graph shape, run timings, timeline) stated in one line.
2. Share list — token prefix, created/revoked timestamps (never full tokens).
3. Actions — **Create link** (token displayed once with copy affordance and the rotate-to-replace note), Rotate, Revoke (destructive; confirmation; spatially separated per Fitts).
**States:**
- Default: preview + existing shares.
- Loading: skeletons.
- Empty: no shares yet — preview still fully rendered (the author reviews scope *before* creating; anxiety-reducing by design).
- Error: action failure banner; token-shown-once modal cannot be reopened (copy states this).
- Success: created → one-time token modal; revoked → row marked immediately.
**Primary CTA:** "Create link" → one-time token display.
**Exit / next:** editor (toggle `public` flags if the preview shows the wrong scope → republish with visibility diff); out of app (send the URL).

### Public view — `/s/[token]` (+ `/runs`, `/runs/[ref]`, `/events`)
**Purpose:** let a link-holder watch the workflow live and historically — graph shape, runs, events — seeing exactly the manifest and nothing else.
**Entry points:** the shared URL only (no in-app navigation leads here; the token is the credential).
**Content blocks (in order):**
1. Overview — workflow name, read-only graph shape (nodes: name/kind/mode; derived edges; schedules), live run summary; local tabs Overview · Runs · Events.
2. Runs — status, attempt, timings; error shown as a **bounded error class** (`timeout`, `retries_exhausted`, …) — never free text; run detail: its trigger, its emissions.
3. Event feed — type, timestamp, source node for every event; **packet bodies only for public types**; private-type entries show an explicit "packet private" marker (an honest withhold, never a silent gap); lineage renders private hops with body omitted, existence retained.
**States:**
- Default: polling live (2s), historical via cursor scroll-back — same path.
- Loading: skeletons.
- Empty: workflow shared before any runs — graph renders, feeds show "nothing yet".
- Error: unknown/malformed/revoked token → identical 404 (no distinction, ever); rate-limited → plain retry-later notice.
- Success: n/a.
**Primary CTA:** none — deliberately read-only; no owner-surface links, no CTA into the product (no marketplace/auth exists; adding one would be invented scope).
**Exit / next:** none (terminal surface); viewers stay or leave.
