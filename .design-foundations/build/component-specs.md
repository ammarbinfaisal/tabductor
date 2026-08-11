# Component specs — Tabductor · "Ruled Ink"

**Phase 6 artifact** · pairs with `DESIGN.md` (LOCKED — every color below is a DESIGN.md alias; a raw hex anywhere in this document is a defect) and `JOURNEY.md` (the page specs are this inventory's source).
**Scope:** every owner and public surface, the shared primitives they compose, the derived-map layout rule, and all microcopy — complete enough that an engineer implements every surface without making a visual or copy decision.
**Method:** atomic decomposition (Frost 2013): §2 primitives → §3 composed components → §4 surfaces. Token tiers (W3C DTCG / Kholmatova): DESIGN.md's semantic layer is the alias tier; §1 adds the component tier as `var()` mappings only — no new values, ever.

---

## 0. Laws that bind every spec below

1. **Token-only color.** Components reference DESIGN.md aliases (`--event-*`, `--node-*`, `--status-*`, `--banner-*`, semantic neutrals). Never `--accent-*`/`--amber-*` directly, never hex.
2. **Type roles** (DESIGN.md): Newsreader = display (titles, empty-state headlines; ≥ `--text-2xl` at most once per view). Source Serif 4 = everything a human reads or writes as prose — descriptions, prompts, error sentences, helper text, empty-state bodies. IBM Plex Mono = everything the machine reads or emits — event types, cron, ids, timestamps, statuses, table numerals, and operational UI labels (buttons, tabs, chips, stamps). **Prose is never mono; a full sentence is never all-mono.**
3. **Labeling law** (JOURNEY): **Publish** = compile a version (never "save", "deploy"). **Share** = the public link. Authors **describe** events. Statuses use only the fixed vocabularies: runs `queued · running · succeeded · failed · timed_out · cancelled`; compile `generated · reused · failed`; public error classes `timeout · retries_exhausted · engine_restart · packet_invalid · loop_budget_exceeded · no_executor · sandbox_kill · policy_denied · other` (docs/sharing.md — never free text on public surfaces).
4. **Redundancy law** (DESIGN.md, ch08; Knaflic 2015 — color is never the sole cue): events = ◈ + mono code style; nodes = kind word; statuses = fixed word inside stamp form; private = lock glyph + `PRIVATE`; cancelled adds line-through; running adds the pulse dot.
5. **Shape law:** the ledger is square. `--radius-0` panels/tables/banners/rules, `--radius-1` stamps/chips/badges, `--radius-2` buttons/inputs — nothing rounder exists.
6. **Containers are rules, not cards.** Separation is `--rule` / `--rule-strong` hairlines on shared paper. The only shadow is `--shadow-modal`, on the two modals (§3.6, §3.7) and nowhere else.
7. **Copy voice:** precise, calm, directive. Errors follow Yifrah's formula — what happened → why → how to fix → what's safe. No blame, no "Oops", no exclamation marks on errors, no "we" in error copy. Front-load the key fact (Redish). All strings in this document are final; `{braces}` mark runtime substitutions only.
8. **Motion** is DESIGN.md's closed set: 120/200/300ms, sharp ease-out, the two expressive moments, the pulse dot. `prefers-reduced-motion`: transforms off, opacity-only ≤120ms, pulse static.

---

## 1. Component-token tier

Paste-ready. Every value is a `var()` onto the DESIGN.md alias tier — restyling a component means editing this block, never the lock (Kholmatova: component tokens encode scope).

```css
:root {
  /* Buttons */
  --btn-primary-bg: var(--event-solid);
  --btn-primary-bg-hover: var(--accent-solid-hover); /* DESIGN.md semantic alias */
  --btn-primary-text: var(--event-on-solid);
  --btn-secondary-border: var(--border-control);
  --btn-secondary-text: var(--text);
  --btn-destructive: var(--status-failed);   /* text + 1.5px border; never solid */
  --btn-disabled-text: var(--text-secondary);
  --btn-disabled-border: var(--border-subtle);

  /* Inputs */
  --input-border: var(--border-control);
  --input-bg: var(--background);
  --input-text: var(--text);
  --input-placeholder: var(--text-secondary);
  --input-error-border: var(--status-failed);

  /* Chips */
  --chip-schedule-text: var(--text-secondary);   /* cron is machinery, not an event */
  --chip-schedule-border: var(--border);
  --chip-invalid-border: var(--status-failed);

  /* Tables */
  --table-header-text: var(--text-secondary);
  --table-row-hover: var(--surface-hover);

  /* Tabs */
  --tab-active-ink: var(--text);          /* ink, never blue — blue never decorates chrome */
  --tab-inactive: var(--text-secondary);
}
```

---

## 2. Primitives (atoms)

### 2.1 Buttons

All buttons: IBM Plex Mono, `--text-sm`, `--radius-2`, padding `var(--space-2) var(--space-4)`, line-height `--leading-ui`, cursor pointer, transition `background 120ms, border-color 120ms` sharp ease-out. Focus-visible: 2px `--focus-ring` ring, 2px offset (all interactive primitives share this focus treatment — stated once here, applies everywhere).

| Variant | Fill | Border | Text | Weight | Hover | Active |
|---|---|---|---|---|---|---|
| **Primary** (Publish, Create link, New workflow) | `--btn-primary-bg` | none | `--btn-primary-text` | 600 | `--btn-primary-bg-hover` | same + translateY(1px) |
| **Secondary** (Trigger now, Add event, Add node, Copy link, Retry, Newer/Older) | transparent | 1.5px `--btn-secondary-border` | `--btn-secondary-text` | 500 | bg `--surface-hover` | bg `--surface-active` |
| **Destructive** (Revoke link, Cancel run, Delete event/node, Rotate now) | transparent | 1.5px `--btn-destructive` | `--btn-destructive` | 500 | bg `--error-3` | bg `--error-3`, border unchanged |
| **Text/tertiary** (Dismiss, Keep, Done, Cancel-in-modal) | none | none | `--text-secondary` | 500 | text `--text`, underline | same |
| **Disabled** (any variant) | transparent | 1.5px `--btn-disabled-border` | `--btn-disabled-text` | 500 | none; cursor default | — |

**Disabled-with-reason** (the only disabled treatment in the product): the disabled button always carries an adjacent reason — Source Serif 4 `--text-sm` `--text-secondary`, placed under the button (right-aligned to it), linked via `aria-describedby`. A disabled control with no reason is a defect. Reason strings: §4.2.
Primary-CTA singleton rule: at most one primary button per view (Publish on the editor; Create link on Share; New workflow on the list).
Destructive actions are never adjacent to their non-destructive neighbor by less than `--space-5` (Fitts 1954; Nielsen #5).

### 2.2 Text input (single-line)

Height 36px, `--radius-2`, 1.5px `--input-border`, bg `--input-bg`, padding `0 var(--space-3)`.
Text: mono `--text-sm` for machine values (workflow name uses §3.5's display variant; cron, numeric limits are mono). Label: mono 500 `--text-xs` uppercase `--tracking-stamp` in `--text-secondary`, persistent above the field, `--space-1` gap — **placeholder is never the label** (WCAG 1.3.5; Penzo 2006 top-aligned). Placeholder: `--input-placeholder`, examples only.
Error state: border `--input-error-border`; error sentence below in Source Serif 4 `--text-sm` `--banner-error-text` (Nielsen #9: adjacent to the failing field). Validate on blur, never on keystroke (NN/g reward-early-punish-late).

**Numeric knob** (timeout, retries): same, width 88px, `inputmode="numeric"`, right-aligned mono, unit rendered after the field as mono `--text-xs` `--text-secondary` (`s` / `tries`).
**Select** (node mode): same box; chevron glyph inline SVG stroked `--text-secondary`; value mono `--text-sm`.

### 2.3 Textarea — prose surface (event description, node prompt)

The writing-is-the-document control (DESIGN.md law): **Source Serif 4, `--text-base`, line-height `--leading-prose`, `--text` on `--background`** — identical to rendered prose. No visible box at rest: border 1.5px transparent; on hover 1.5px `--border-subtle`; on focus 1.5px `--input-border` + focus ring. `--radius-2`. Padding `var(--space-2) var(--space-3)`, min-height 3 lines, auto-grow to 12 then scroll. Label per §2.2.

### 2.4 Switch (the public toggle)

Square-cornered per shape law. Track 32×18, `--radius-1`, 1.5px border. Thumb 12×12, `--radius-1`, bg `--background`, inset 2px, translates 14px on. Motion: transform 120ms.

| State | Track fill | Track border | Companion |
|---|---|---|---|
| Off | `--surface-active` | `--border-control` | — |
| On | `--event-solid` | `--event-border` | card gains the `PUBLIC` visibility stamp (§2.6) |
| Disabled | `--surface` | `--border-subtle` | reason per §2.1 |

Label (right of track, `--space-2` gap): mono 500 `--text-sm` `--text` — **"Readable in share links"**. `role="switch"`, `aria-checked`.

### 2.5 Chips

Lowercase mono in a tinted field — the *entity* form (distinct from the stamp form by design; DESIGN.md §Redundancy). All chips: `--radius-1`, mono 500 `--text-sm`, padding 2px 8px, 1.5px border, line-height `--leading-ui`.

| Chip | Fill | Border | Text | Content |
|---|---|---|---|---|
| **Event chip** | `--event-bg` | `--event-border` | `--event-text` | `◈ tweet.detected` — glyph + type, always together |
| **Node kind badge** | `--node-bg` | `--node-border` | `--node-text` | the word `browser` or `asset` |
| **Schedule chip** | transparent | `--chip-schedule-border` | `--chip-schedule-text` | the raw cron, e.g. `*/5 * * * *` |
| **Invalid chip** (save-gate reject) | `--event-bg` | `--chip-invalid-border` | `--event-text` | chip + inline error sentence below the row (§4.2 E7) |

**Interactive chip rows** (trigger/emit on the node card): each removable chip carries a trailing `×` (mono, same color as chip text, 16×16 hit area padded to 24×24; `aria-label="Remove ◈ tweet.detected"`). Row ends with a ghost add chip — dashed 1.5px `--border` border, transparent fill, `--text-secondary` text: **`+ event`** (trigger row also offers **`+ cron`**). Activating it opens a menu (bg `--background`, border 1px `--border`, `--radius-2`, no shadow) listing every declared event as an event chip (recognition over recall, Nielsen #6), filtered by typing; the last row is always **"Declare new event…"** — choosing it creates a blank event card in the Events panel, scrolls to it, and focuses its description.

### 2.6 Stamps (the signature)

Per DESIGN.md: 1.5px solid border + text in the family color, transparent bg, `--radius-1`, IBM Plex Mono 500 `--text-xs`, uppercase, `letter-spacing: var(--tracking-stamp)`, padding 2px 8px. Stamps sit at the **margin edge** of what they judge. Not interactive, `role="status"` where they change live.

| Stamp | Color (border + text) | Label | Extra cue |
|---|---|---|---|
| QUEUED | `--status-queued` | `QUEUED` | — |
| RUNNING | `--status-running` | `RUNNING` | 6px dot, fill `--info-9`, left of label, 2s opacity pulse (static under reduced motion) |
| SUCCEEDED | `--status-succeeded` | `SUCCEEDED` | — |
| FAILED | `--status-failed` | `FAILED` | — |
| TIMED OUT | `--status-timed-out` | `TIMED OUT` | — |
| CANCELLED | `--status-cancelled` | `CANCELLED` | label line-through |
| GENERATED | `--compile-generated` | `GENERATED` | — |
| REUSED | `--compile-reused` | `REUSED` | — |
| FAILED (compile) | `--compile-failed` | `FAILED` | lands tilted −1.5° in the report (§3.4) |
| PUBLIC | `--visibility-public-text` | `PUBLIC` | fill `--visibility-public-bg` (the one filled stamp); ◈ before label |
| PRIVATE | `--visibility-private-text` | `PRIVATE` | border **dashed**; lock glyph (inline SVG, 10px, stroke = text color) before label |
| REVOKED | `--status-cancelled` | `REVOKED` | — |
| LOOP | `--map-annotation` | `LOOP` | map only, §3.3 |

Public-view error classes render as a mono `--text-xs` word in `--status-failed` beside the FAILED stamp (e.g. `FAILED  retries_exhausted`) — class vocabulary only, never a sentence.

### 2.7 Banners

Full-width ruled slab: `--radius-0`, 3px solid left border, padding `var(--space-3) var(--space-4)`, sentence in Source Serif 4 `--text-sm`/1.5; machine names inside the sentence (event types, versions) stay mono. Trailing action: text button or secondary button per string spec. Dismiss `×` top-right only where the string spec says dismissable.

| Variant | Bg | Left border | Text |
|---|---|---|---|
| Error | `--banner-error-bg` | `--error-9` | `--banner-error-text` |
| Warning (cycle/loop-budget, visibility caution) | `--banner-warning-bg` | `--warning-9` | `--banner-warning-text` |
| Notice (neutral info, rate-limit) | `--surface` | `--border-strong` | `--text` |

### 2.8 Modal

Only two exist: visibility-diff (§3.6) and one-time token (§3.7). Overlay: `--neutral-12` at 40% opacity (`color-mix(in srgb, var(--neutral-12) 40%, transparent)` — no new hex). Panel: bg `--background`, 1px `--border-strong` border, `--radius-0` (a document sheet, not a card), `--shadow-modal`, width min(560px, calc(100vw − 2·`--space-5`)), padding `--space-6`. Title: Newsreader 600 `--text-xl`. Body: Source Serif 4 `--text-base`/`--leading-prose`. Footer: buttons right-aligned, `--space-3` gap, **Cancel/text-tertiary receives initial focus** (safe default). Entry: opacity + translateY(8px→0) 200ms; exit 120ms. Escape and overlay-click cancel (except §3.7: Escape = "Done", stated in copy). Focus trapped; `aria-modal`.

### 2.9 Skeletons

Blocks of `--surface-active`, `--radius-1`, shaped like the content they replace (row bars 16px high, marker-shaped in the map region). Opacity 1→0.6→1 over 1.8s (never faster than 1.5s; DESIGN.md motion law); static under reduced motion. Show only after 300ms of pending load (Doherty); replace atomically, no layout shift.

### 2.10 Tab bar

Owner surfaces: **Editor · Runs · Events · Share**. Public: **Overview · Runs · Events**. Mono 500 `--text-sm`, labels as written (title-case words, not uppercase — stamps own uppercase). Inactive `--tab-inactive`; hover `--text`; active `--tab-active-ink` + 2px `--tab-active-ink` underline sitting on the header's `--rule-strong`. Tab hit area padded `var(--space-2) var(--space-3)` min-height 40px. Blue never marks the active tab.

### 2.11 Links & breadcrumb

Links: `--link`, underline always (color never the sole cue), Source Serif in prose / mono in chrome, hover `--text`. Breadcrumb (owner header): mono `--text-xs` `--text-secondary`: `Workflows /` before the workflow name; the crumb is a link.

### 2.12 Schema field row (read-only compiled schema)

The no-raw-JSON law's display form. A ruled mini-table, one row per field, `--rule` between rows, row padding `var(--space-1) 0`:

`{name}` mono 500 `--text-sm` `--text` · `{type}` mono 400 `--text-sm` `--text-secondary` · `{detail}` (format/enum, when present) mono 400 `--text-xs` `--text-secondary` right-aligned · required fields suffix the name with mono `*` (legend once per card footer: `* required` mono `--text-xs` `--text-secondary`).
One nesting level: child rows indent `--space-4` with a `--border-subtle` 1px left rule; data arrives pre-flattened as `{name, type, required, detail}`.
Example rows (tweet.detected): `text* string` · `author* string handle` · `url* string uri` · `posted_at* string date-time`.

### 2.13 Keyset pagination

Row under the table, right-aligned: secondary buttons **"Newer"** · **"Older"**, `--space-3` gap, disabled (with no reason line — edge-of-data is self-evident, the one exception to §2.1, stated here) at the respective end. Never page numbers (keyset has none).

### 2.14 Timestamps, durations, numerals

All mono. Table timestamp: `Aug 10 14:32:05` (`MMM D HH:MM:SS`, 24h, local), `title` = full ISO-8601. Feed rows may prepend a date rule-row when the day changes: mono `--text-xs` `--text-secondary` `— Aug 10 —` centered between rules. Duration: `<60s` → one decimal (`4.2s`); `≥60s` → `1m 12s`; `≥1h` → `1h 04m`. Attempt: plain integer. Numerals right-aligned in table columns.

---

## 3. Composed components

### 3.1 Event card (Events panel)

A ruled section, not a card: `--radius-0`, separated from siblings by `--rule`, left tint strip 3px solid `--event-bg` full height (the panel's entity marker), padding `var(--space-4) var(--space-4) var(--space-4) var(--space-5)`.

Anatomy, top to bottom:
1. **Title row** — `◈ {type}` mono 600 `--text-lg` `--event-text` (e.g. `◈ tweet.detected`). Right margin edge: the **compile stamp** (`GENERATED`/`REUSED`/`FAILED`) once the event has ever been published; the `PUBLIC` stamp beside it when the switch is on. Draft-only events carry no compile stamp (nothing has judged them yet).
2. **Description** — label `DESCRIPTION`, prose textarea (§2.3). Placeholder: *"A tweet found on the timeline: its text, author handle, permalink URL, and when it was posted."*
3. **Recompile note** (conditional, after an edit to a published event or its neighborhood prompts): mono `--text-xs` `--text-secondary`: **`recompiles on publish`**.
4. **Public switch** — §2.4, label **"Readable in share links"**.
5. **Compiled schema** — label `SCHEMA · compiled from the description` mono `--text-xs` uppercase `--text-secondary`; then §2.12 field rows. Absent until first successful compile; in its place, Source Serif `--text-sm` `--text-secondary`: **"No schema yet — it's compiled from the description when you publish."**
6. **Failure text** (only when stamp = FAILED): Source Serif 4 `--text-sm` `--banner-error-text`, the compiler error verbatim in quotes, then the direction: **"{compiler error}." + "The schema comes from the prose — edit the description, then publish again."**
7. **Footer row** — right-aligned destructive text-size button **"Delete"** (§2.1 destructive, `--text-xs` padding 2px 8px), ≥ `--space-5` from the switch. Two-step inline confirm (§3.9) with copy C-DEL-E (§4.2).

States: default · card-flash (deep-linked from a banner: bg `--event-bg` fading to transparent 600ms — the ink-soak treatment reused, allowed because it is the same moment vocabulary) · failed (stamp + item 6) · deleting (two-step confirm open).

### 3.2 Node card (Nodes panel)

Same ruled-section construction; left tint strip 3px `--node-bg`.

1. **Title row** — kind badge chip (`browser`/`asset`, §2.5) then **name**: single-line input (§2.2) styled as mono 600 `--text-lg` `--text`, borderless at rest (border appears on hover/focus like §2.3). Right margin edge: run-status stamp of the node's most recent run, when one exists.
2. **Prompt** — label `PROMPT`, prose textarea (§2.3). Placeholder: *"Open the timeline, find new tweets, and emit one tweet.detected per new tweet."*
3. **Triggers** — label `TRIGGERS` (mono `--text-xs` uppercase `--text-secondary`); chip row: schedule chip(s) + consumed-event chips + ghost adds `+ cron` / `+ event` (§2.5). Adding a cron opens a 160px mono inline input pre-filled `* * * * *`, validated on blur; invalid → §2.2 error treatment with **"That's not a valid cron expression — five fields, like */5 * * * *."**
4. **Emits** — label `EMITS`; event chips + `+ event` ghost. Save-gate rejection renders the invalid-chip state (§2.5) with copy E7 (§4.2).
5. **Mode & limits** — one row, `--space-4` gaps: select `MODE` (product-defined options); numeric knob `TIMEOUT` unit `s`; numeric knob `RETRIES` unit `tries`. No JSON exists on this card.
6. **Footer row** — left: secondary button **"Trigger now"**; after activation it shows an adjacent mono `--text-xs` `--text-secondary` note for 5s: **"Run queued · view in Runs"** (Runs is a link). Right, ≥ `--space-5` away: destructive **"Delete"**, two-step confirm, copy C-DEL-N.

### 3.3 Derived Map — layout rule (concrete; plain SVG)

Read-only, inline `<svg>` in the DOM (inline so CSS custom properties cascade into `fill`/`stroke`). No library, no canvas. Data-viz posture (Tufte VDQI): marks are only markers, edges, labels, and the one annotation — no background, no grid, no decoration. Position on a common horizontal scale encodes topological order (Munzner: position is the strongest channel).

**Input:** markers `{kind: "task"|"event", id, layer}` (pre-computed layers), edges `{from, to, isCycleBack}`.

**Geometry (all px; spacing derives from the `--space` scale as noted):**
- Column slot width `SLOT = 160`; column gap `GAP = 64` (= `--space-8`); margin `M = 32` (= `--space-6`).
- **Layer → column:** `slotX(layer) = M + layer × (SLOT + GAP)`. Layer 0 is leftmost; layers alternate task/event by construction (bipartite).
- **Rows within a column:** stack in input order, top-aligned; vertical gap `24` (= `--space-5`). Vertically center each column against the tallest column.
- **Marker size:** label width is deterministic (mono): `w = clamp(72, 16 + 7.2 × chars, SLOT)` where `chars` = longest rendered line (7.2px = 0.6em at `--text-xs` 12px; 16 = 2×8px padding). Center the marker in its slot: `x = slotX(layer) + (SLOT − w)/2`. Task height `44` (two lines), event height `28` (one line).
- **Task marker:** `<rect>` `--radius-0`, fill `--node-bg`, stroke 1.5px `--node-border`. Line 1: name, mono 500 12px, fill `--node-text`, centered, baseline at markerY+18. Line 2: kind word (`browser`/`asset`), mono 400 12px, fill `--node-text`, baseline at markerY+34 (the redundancy word — never omitted).
- **Event marker:** `<rect>` rx = 2 (`--radius-1` — the chip form; markers echo the chip/panel forms used everywhere, Kholmatova perceptual consistency), fill `--event-bg`, stroke 1.5px `--event-border`. One line: `◈ {type}`, mono 500 12px, fill `--event-text`, centered, baseline markerY+18.
- **Labels:** single line, no wrapping; truncate the *type/name* to fit `SLOT` minus padding with a trailing `…` and put the full text in a `<title>` child. ◈ is never truncated away.
- **Forward edges:** straight `<line>` from source right-edge midpoint to target left-edge midpoint, stroke `--map-edge` 1px, `marker-end` arrowhead (path `M0,0 L6,3 L0,6 z`, fill `--map-edge`, 6×6, refX 6).
- **Cycle back-edges** (`isCycleBack`): orthogonal channel below the graph — exit the source's bottom-center, go down to `channelY = maxMarkerBottom + 24`, run left, rise to the target's bottom-center, arrowhead pointing up. Same stroke; square joins (`stroke-linejoin: miter` — ruled, not curved). Multiple back-edges stack channels `+16` apart.
- **Loop annotation:** at the horizontal run's midpoint, `8` above the channel line: the `LOOP` stamp (§2.6, `--map-annotation`) rendered as a `<g>` (rect 1.5px stroke + uppercase text), followed on the same baseline by mono 12px `--map-annotation`: **`capped at {max_hops} hops`**. One annotation per back-edge.
- **A11y:** `role="img"`; `aria-label="Workflow map: {n} nodes and {m} events. {task} emits {event}; …"` (generated sentence per edge, cycle edges phrased "… which loops back to {task}"). Each marker gets a `<title>`.
- **States:** empty → §4.2 E4 copy centered in the region (no SVG). Updating (chips toggled): re-render in place, no transition (the map is evidence, not theater). Overflow: the region scrolls horizontally (`overflow-x: auto`); never scale text down.

**Reference implementation** — the canonical workflow (Timeline scraper → ◈tweet.detected → Ranker → ◈tweet.ranked → Curator → ◈scrape.requested ⟲), exactly the rule above (layers 0–5, one marker per layer, mid-y 57, channelY 103):

```html
<svg viewBox="0 0 1344 140" role="img"
     aria-label="Workflow map: 3 nodes and 3 events. Timeline scraper emits tweet.detected; Ranker consumes tweet.detected and emits tweet.ranked; Curator consumes tweet.ranked and emits scrape.requested, which loops back to Timeline scraper."
     style="font-family: var(--font-mono); font-size: 12px;">
  <defs>
    <marker id="arrow" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L6,3 L0,6 z" fill="var(--map-edge)"/>
    </marker>
  </defs>
  <!-- forward edges -->
  <g stroke="var(--map-edge)" stroke-width="1" marker-end="url(#arrow)">
    <line x1="178" y1="57" x2="270" y2="57"/>
    <line x1="402" y1="57" x2="524" y2="57"/>
    <line x1="596" y1="57" x2="725" y2="57"/>
    <line x1="843" y1="57" x2="972" y2="57"/>
    <line x1="1044" y1="57" x2="1159" y2="57"/>
  </g>
  <!-- cycle back-edge: scrape.requested → Timeline scraper -->
  <path d="M1232,71 V103 H112 V79" fill="none" stroke="var(--map-edge)" stroke-width="1"
        stroke-linejoin="miter" marker-end="url(#arrow)"/>
  <!-- loop annotation at channel midpoint -->
  <g transform="translate(614,84)">
    <rect x="0" y="0" width="46" height="16" rx="2" fill="none" stroke="var(--map-annotation)" stroke-width="1.5"/>
    <text x="23" y="12" text-anchor="middle" fill="var(--map-annotation)" font-weight="500"
          letter-spacing="0.08em">LOOP</text>
    <text x="54" y="12" fill="var(--map-annotation)">capped at 8 hops</text>
  </g>
  <!-- task markers -->
  <g>
    <rect x="46" y="35" width="132" height="44" fill="var(--node-bg)" stroke="var(--node-border)" stroke-width="1.5"/>
    <text x="112" y="53" text-anchor="middle" fill="var(--node-text)" font-weight="500">Timeline scraper<title>Timeline scraper</title></text>
    <text x="112" y="69" text-anchor="middle" fill="var(--node-text)">browser</text>
    <rect x="524" y="35" width="72" height="44" fill="var(--node-bg)" stroke="var(--node-border)" stroke-width="1.5"/>
    <text x="560" y="53" text-anchor="middle" fill="var(--node-text)" font-weight="500">Ranker</text>
    <text x="560" y="69" text-anchor="middle" fill="var(--node-text)">asset</text>
    <rect x="972" y="35" width="72" height="44" fill="var(--node-bg)" stroke="var(--node-border)" stroke-width="1.5"/>
    <text x="1008" y="53" text-anchor="middle" fill="var(--node-text)" font-weight="500">Curator</text>
    <text x="1008" y="69" text-anchor="middle" fill="var(--node-text)">browser</text>
  </g>
  <!-- event markers -->
  <g>
    <rect x="270" y="43" width="132" height="28" rx="2" fill="var(--event-bg)" stroke="var(--event-border)" stroke-width="1.5"/>
    <text x="336" y="61" text-anchor="middle" fill="var(--event-text)" font-weight="500">◈ tweet.detected</text>
    <rect x="725" y="43" width="118" height="28" rx="2" fill="var(--event-bg)" stroke="var(--event-border)" stroke-width="1.5"/>
    <text x="784" y="61" text-anchor="middle" fill="var(--event-text)" font-weight="500">◈ tweet.ranked</text>
    <rect x="1159" y="43" width="146" height="28" rx="2" fill="var(--event-bg)" stroke="var(--event-border)" stroke-width="1.5"/>
    <text x="1232" y="61" text-anchor="middle" fill="var(--event-text)" font-weight="500">◈ scrape.requested</text>
  </g>
</svg>
```

(`8` in "capped at 8 hops" is the example's `max_hops`; substitute the workflow's configured value.)
The public-view map is this same component with the same inputs — nothing owner-only exists in it.

### 3.4 Compile report (the stamp moment)

Not a modal — a ruled section that slides open (height + opacity 300ms) directly under the editor header, above the banner region, and stays until dismissed.
- Header row: mono 500 `--text-sm` `--text`: **"Compile report · publishing v{n}"**, becoming **"Compile report · v{n} published"** on success or **"Compile report · publish failed"** on failure; right: text button **"Dismiss"**.
- One ruled row per event, in event order (chunked short list, Cowan 4±1): `◈ {type}` mono `--text-sm` `--event-text`, stamp at the right margin edge.
- **The one indulgent animation** (DESIGN.md): each stamp lands scale 1.06→1 + opacity 0→1, 160ms sharp ease-out, staggered 60ms in event order; FAILED stamps land last and settle at −1.5° tilt; GENERATED/REUSED stay square. Reduced motion: opacity-only ≤120ms, no tilt animation (tilt may still be the static end state).
- FAILED rows append below the row, Source Serif `--text-sm` `--banner-error-text`: the verbatim compiler error in quotes.
- Footer, Source Serif `--text-sm` `--text-secondary`:
  - success: **"{e} events · {g} generated · {r} reused. Schemas updated on the event cards."**
  - failure: **"Nothing was published — v{n} is unchanged. Fix the failed description and publish again."**

### 3.5 Editor header + banner region

Header (bg `--background`, bottom `--rule-strong`, padding `var(--space-4) var(--space-6)`):
- Breadcrumb `Workflows /` (§2.11), then **workflow name** — inline single-line input styled as Newsreader 600 `--text-2xl` `--text`, borderless at rest (§2.3 border behavior); default value for a new workflow: **"Untitled workflow"**. (The view's one display-type instance.)
- **Version indicator** beside the name, mono `--text-xs` `--text-secondary`, baseline-aligned: `v{n}` · with unpublished edits: **"v{n} · unpublished edits"** · never published: **"draft · never published"**.
- Top-right, isolated by ≥ `--space-6` (Fitts): primary **"Publish"**. Disabled-with-reason per §2.1; reasons §4.2 R1–R3.
- Below the header rule: the **tab bar** (§2.10).

**Banner region** sits under the tab bar. One error banner (§2.7) **per failed event**, stacked with `--rule` between. String: template E5 (§4.2). The trailing mono link **"Go to ◈ {type} ↓"** scrolls to the event card and fires its card-flash state. Transport failure renders the single banner E6. The cycle notice (first time a publish introduces a cycle) renders a warning banner W1, dismissable.

### 3.6 Visibility-diff modal

§2.8 chassis. Title: **"This publish changes what share links show"**. Intro (body): **"Anyone with a share link sees the difference immediately."**
Then up to two labeled lists (mono `--text-xs` uppercase `--text-secondary` headers; omit an empty one):
- `BECOMING PUBLIC` — per event, one ruled row: event chip + mono `--text-sm` `--text-secondary` field list: `◈ tweet.ranked — fields: text, author, url, score`
- `BECOMING HIDDEN` — `◈ scrape.requested — packet no longer readable; the event itself stays listed`
Footer: primary **"Publish with these changes"** · text **"Cancel"** (initial focus). Cancel aborts the whole publish (F2: nothing published).

### 3.7 One-time token modal

§2.8 chassis. Title: **"Your share link"**.
URL slab: full URL, mono `--text-sm` `--text`, bg `--surface`, 1px `--border` border, `--radius-1`, padding `--space-3`, user-selectable, wraps.
Body: **"This is the only time the full link is shown. Copy it now — if you lose it, rotate the share to get a new link and the old one stops working."**
Footer: secondary **"Copy link"** (on success its label becomes **"Copied"** for 2s, `aria-live="polite"`) · text **"Done"** (Escape = Done; closing is safe, the copy already warned).

### 3.8 Tables (runs · feed · share list · workflow list share one chassis)

Chassis: `--radius-0`; header row mono 500 `--text-xs` uppercase `--tracking-stamp` `--table-header-text`, bottom `--rule-strong`; body rows separated by `--rule`, padding `var(--space-3) var(--space-4)`, bg transparent, hover `--table-row-hover` (only when the row navigates); cell text mono `--text-sm` `--text` unless specified. Column specs per surface in §4. Loading: 6 skeleton rows (§2.9). Error: banner E8 above the table.

### 3.9 Two-step inline confirm (shared pattern)

For destructive actions outside the two modals (Cancel run, Delete event/node, Revoke, Rotate). First activation swaps the control in place for: consequence sentence (Source Serif `--text-sm` `--text`) + destructive button (specific verb) + text button **"Keep"**. Initial focus: "Keep". Reverts on blur-out or after 8s untouched. The destructive button label always names the object class (**"Delete event"**, never "Yes").

---

## 4. Surfaces

### 4.1 Workflow list — `/workflows`

Header: Newsreader 600 `--text-xl` **"Workflows"**; top-right primary **"New workflow"** → creates and opens the editor ("Untitled workflow", draft).
Table (§3.8): columns `NAME` (Newsreader 500 `--text-lg` `--text` — the one non-mono cell; row link) · `TASKS` (count, right-aligned) · `LAST RUN` (run stamp §2.6 + timestamp §2.14; em-dash `—` in `--text-secondary` when never run). Sort: most recently active first. Row click → editor.
**Empty (first-use):** centered, `--space-9` top padding — Newsreader 500 `--text-3xl` **"Describe it. Publish it. Watch it run."** · Source Serif `--text-base` `--text-secondary` **"A workflow is events you describe and nodes you prompt — no schemas, no wiring."** · primary **"New workflow"** (the page's only large target).
**Error:** banner E8 with `{the workflow list}`.

### 4.2 The editor — `/workflows/[id]` + all editor copy

Layout: header + tabs (§3.5) · compile report slot (§3.4) · banner region · two-column panel row (Events 1fr | vertical `--rule-strong` | Nodes 1fr; stacks to one column under 960px, Events first) · full-width ruled Map section (§3.3, section label `MAP` mono `--text-xs` uppercase `--text-secondary`). Panels titled `EVENTS` / `NODES` (same label style) with the ghost-form secondary buttons **"Add event"** / **"Add node"** at panel end.

**Empty states (first-use formula — what it does + what to do; Redish/NN/g):**
- E1 Events panel: **"Events are the packets your nodes exchange. Describe the first one in prose — the description becomes its schema when you publish."** + **"Add event"**
- E2 Nodes panel: **"Nodes do the work. Add one, tell it what to do in its prompt, then choose which events it consumes and emits."** + **"Add node"**
- E4 Map region: **"The map draws itself from your declarations. It appears when a node consumes or emits an event."**
(Empty-state bodies: Source Serif `--text-base` `--text-secondary`; no headline inside panels — the panel label is the header.)

**Publish disabled-reasons (§2.1 treatment):**
- R1 (empty draft): **"Publish needs at least one event and one node."**
- R2 (save-gate failing): **"Fix the flagged chips first — every trigger and emit must name a declared event."**
- R3 (no changes): **"Everything here is already published as v{n}."**

**Inline gate error (invalid chip, §2.5):**
- E7: **"'{name}' isn't a declared event. Describe it in Events, or pick one from the list."**

**Compile failure (per-event banner, §3.5):**
- E5 template: **"◈ {type} didn't compile: "{compiler error}". The schema comes from the prose — edit the description, then publish again. Nothing was published; v{n} is unchanged."** + link **"Go to ◈ {type} ↓"**
- E5 filled example: *◈ tweet.ranked didn't compile: "description does not determine a field type for 'score'". The schema comes from the prose — edit the description, then publish again. Nothing was published; v3 is unchanged.*
  (What → why → fix → what's safe: Yifrah formula, atomicity stated per JOURNEY F2.)
- E6 (transport, single banner): **"Publish didn't reach the compiler. Nothing changed — v{n} is still live."** + secondary **"Retry"**
- W1 (cycle warning banner, dismissable): **"This graph loops: ◈ scrape.requested feeds back into Timeline scraper. Loops are allowed and capped at {max_hops} hops per causation chain."**

**Delete confirms (§3.9):**
- C-DEL-E (referenced event): **"Delete ◈ {type}? {Node A} emits it and {Node B} consumes it — their chips will be flagged until you rewire them. Its history stays in Runs and Events."** → **"Delete event"** / **"Keep"**
- C-DEL-E (unreferenced): **"Delete ◈ {type}? No node references it. Its history stays in Runs and Events."**
- C-DEL-N: **"Delete {name}? Nothing will emit its events after your next publish. Past runs and packets stay in history."** → **"Delete node"** / **"Keep"**

### 4.3 Runs — `/workflows/[id]/runs`

Table (§3.8), newest first, 2s poll. Columns:
`STATUS` (leading; run stamp §2.6) · `TASK` (mono `--text-sm` `--node-text`) · `ATTEMPT` (right-aligned) · `STARTED` (§2.14) · `DURATION` (right-aligned; live-ticking for running rows) · trailing action column.
Failed rows (owner): full error text below the row, Source Serif `--text-sm` `--banner-error-text`, verbatim in quotes — data, not an error state.
In-flight rows: trailing destructive text button **"Cancel"** → §3.9: **"Stop this run? Work already done stays recorded; the run is marked cancelled."** → **"Cancel run"** / **"Keep"**. The action column is separated from the row's navigable area (row click → run context: its trigger + emissions as event chips).
Pagination §2.13. **Empty:** **"No runs yet. Publish, wait for a schedule, or use Trigger now in the editor."** + link **"Open the editor"**. **Error:** E8 with `{the runs list}`.
- E8 template (load-failure banner, all list surfaces): **"The {surface} didn't load."** + secondary **"Retry"**

### 4.4 Event feed — `/workflows/[id]/events`

Feed rows (§3.8 chassis): `◈ {type}` event chip · source task mono `--text-sm` `--node-text` · timestamp (§2.14; day rule-rows per §2.14) · packet preview: first fields inline, mono `--text-xs` `--text-secondary`, one line, ellipsized (`text: "Big if true…" · author: "@sara"`). Row click → detail.
**New-row arrival (the peak):** bg `--event-bg` → transparent, 600ms — the only row motion in the product.
**Detail (expands under the row, `--rule` framed):**
- Packet as §2.12 field rows with values: value column mono `--text-sm` `--text`, strings quoted, wrapped; a `<pre>` (mono `--text-xs`, bg `--surface`, `--radius-1`, padding `--space-3`) below for the raw packet — display-only.
- **Lineage** — label `LINEAGE` (§ label style): a vertical chain, one row per hop: event chip + source task + timestamp, connected by a 1px `--map-edge` left rule; the inspected event's row bg `--surface`. Depth cap note at each cut end, mono `--text-xs` `--text-secondary`: **"chain capped at {depth} hops"**.
**Empty:** **"No events yet. Packets land here when a node runs — Trigger now in the editor is the fastest way to see one."** + link **"Open the editor"**. **Error:** E8 with `{the event feed}`. Pagination §2.13, 2s poll.

### 4.5 Share management — `/workflows/[id]/share`

Block 1 — **Visibility preview** (always rendered, even with zero shares):
- Always-visible line first (Redish front-load), Source Serif `--text-sm` `--text`: **"Every link always shows: the workflow name, the graph shape — node names, kinds, modes, and edges — schedules, run statuses and timings, and the event timeline. Packet contents appear only for events marked public."**
- `PUBLIC EVENTS` (label style §4.2): per event a ruled row — event chip + **"from {emitter}"** (mono `--text-sm` `--node-text`) + its §2.12 field names inline (mono `--text-xs` `--text-secondary`: `text · author · url · posted_at`). PUBLIC stamp at margin edge.
- `PRIVATE EVENTS`: `◈ scrape.requested · from Curator` + Source Serif `--text-sm` `--text-secondary` **"packet never shown"**. PRIVATE stamp at margin edge.
- Footer link: **"Change what's public in the editor"** → editor (the toggles live there; republishing shows the diff, F4 step 2).

Block 2 — **Share links** table (§3.8): `LINK` (token prefix mono, e.g. `sh_3f8a…`) · `CREATED` (§2.14) · `STATUS` (active: em-dash; revoked: REVOKED stamp + revoked-at timestamp; revoked rows' text `--text-secondary`) · trailing actions: secondary **"Rotate"**, destructive **"Revoke"**, ≥ `--space-5` apart.
- Rotate → §3.9: **"Replace this link? The current URL stops working the moment the new one exists."** → **"Rotate now"** (destructive style) / **"Keep"** → on confirm, the one-time token modal (§3.7) with the new URL.
- Revoke → §3.9: **"Revoke this link? Anyone holding it loses access immediately and sees the same not-found page as any bad address. This can't be undone — create a new link to share again."** → **"Revoke link"** / **"Keep"**.
**Primary CTA:** **"Create link"** (top-right of block 2) → §3.7 modal.
**Empty (list only):** **"No links yet. Review the preview above, then create the first one — the URL is shown exactly once."**
**Error:** action failure banner (§2.7 error): **"That didn't go through — the link is unchanged."** + **"Retry"**; E8 with `{the share list}` for load failure.

### 4.6 Public view — `/s/[token]` (+ `/runs`, `/runs/[ref]`, `/events`)

Same components, parameterized read-only; no owner links, no primary CTA anywhere; tabs **Overview · Runs · Events** (§2.10).
- **Overview:** workflow name (Newsreader 600 `--text-2xl`) · the Map (§3.3, identical component) · run summary line: last-run stamp + mono `--text-sm` **"{Aug 10 14:32:05} · {24} runs in the last 24h"** · schedules as schedule chips with mono `--text-xs` `--text-secondary` timezone suffix.
- **Runs:** §4.3 table minus Cancel, minus error text — `FAILED` rows show the stamp + the bounded class word (§2.6): `FAILED  retries_exhausted`. Never a sentence, never free text. Run detail: its trigger + emissions as event chips.
- **Events:** §4.4 feed; packet bodies only for public types. Private-type rows keep type/source/timestamp; the preview slot renders the PRIVATE stamp (dashed + lock) + Source Serif `--text-sm` `--text-secondary` **"Packet withheld by the owner."** Detail for private hops in lineage: chip + stamp, body omitted, existence retained.
- **Empty (pre-run share):** map renders; runs/events lists: **"Nothing yet — this workflow hasn't run."** (no CTA; viewers can't act).
- **Rate-limited:** notice banner (§2.7): **"Updates paused — too many requests. This view resumes on its own in a moment."**
- **Unknown/malformed/revoked token → the product's one 404 page, byte-identical in all cases:** Newsreader 500 `--text-3xl` **"Nothing here."** · Source Serif `--text-base` `--text-secondary` **"There's nothing at this address."** No links, no distinction, ever.

---

## 5. Coverage — JOURNEY.md page spec → spec sections (DW-6.1)

| JOURNEY surface | Spec sections |
|---|---|
| Workflow list | §4.1 · §3.8 · §2.1/2.6/2.9/2.14 |
| Editor (events · nodes · map · chrome) | §4.2 · §3.1–3.6 · §2.1–2.9/2.12 |
| Runs | §4.3 · §3.8/3.9 · §2.6/2.13/2.14 |
| Event feed | §4.4 · §3.8 · §2.5/2.12–2.14 |
| Share management | §4.5 · §3.7/3.8/3.9 · §2.6 |
| Public view | §4.6 · §3.3 · §2.6/2.7 · the one 404 |
| Shared primitives (plan item 10) | §2.1–2.14 · §3.8/3.9 |

## 6. Open flags for the mock phase (recorded, not resolved here)

1. Newsreader optical sizing at `--text-2xl` on low-DPI — verify in the mock; fallback is Spectral at the same tokens (DESIGN.md open question).
2. Runs-table stamp density — if every-row stamps read busy in the mock, drop borders to the leading column's stamps only (form change; token values untouched).
3. Map back-edge channel with >2 back-edges — stacking rule specified (§3.3); confirm legibility at real widths in the mock.
