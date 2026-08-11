# Design: Ruled Ink
**Date:** 2026-08-10 · **Status:** confirmed · **Token block: LOCKED**
**Direction confirmed by the user at plan time: "calm technical document"** — light, editorial, generous spacing; the workflow reads as a specification you annotate, not a control room.
**Archetype:** Sage (measured, precise — the tool's authority is legibility, not spectacle) · **Register:** calm structure · expressive at: the compile report (stamping) and the first-packet arrival
**Grounding:** Tufte's book pages' ruled sidenote apparatus (margins as working space, hairlines as structure) + a passport page's stamped officialdom (statuses as physical marks of record)
**DNA:** Editorial Minimalism base + utility-mono technical voice borrowed from Data-Dense Professional · **Dominant axis:** composition (the ruled ledger apparatus IS the identity)
**Composition:** \<dealt\> Editorial Minimalism × **Ledger Grid** (variance 2 — "ruled paper: hairlines structure everything; tabular rows; rank by position and weight, not size") · dealer seed `tabductor|2026-08-10|0|pin:chroma=muted,family=editorial-minimalism`, hand 3 of 5, ledger `.design-foundations/used-dna.json`
**Pins:** `family=editorial-minimalism`, `chroma=muted` (both derived from the user-confirmed brief) · converge-time swap: signature `duotone-images` → `marginalia-stamps` (deck signature; the dealt one was unexecutable — the product has no imagery). Full deal/critique record: `.design-foundations/build/design-phase-5-discovery.md`. Pinned values are user law.

## Direction

A well-set specification on warm-white paper, ruled with hairlines like a ledger, written in serif prose and annotated by its own machinery in ink and stamp. Two inks run through the whole product: **ink-blue for events** (the contracts — the connective tissue of the spec) and **amber for nodes** (the machinery that acts — warm, so the actors sit forward). Everything operational — event types, cron, run ids, statuses — is set in mono, crisp against the prose. The system's voice is a stamped mark in a margin, never a glowing dashboard.

## Signature move

**Marginalia stamps.** Every status in the product renders as a small rubber-stamp-style mark: 1.5px solid border and text in the status family's `-11` color, transparent background, `--radius-1` (2px), IBM Plex Mono 500 at `--text-xs`, uppercase, `letter-spacing: 0.08em`, padding 2px 8px. Stamps live at the margin edge of the row/card they judge (compile status on the event card's right margin, run status in the runs table's leading column, `PRIVATE` beside withheld packets). In calm structure the stamp just sits there, printed. At the expressive moment (below) it *lands*.

## Expressive moments

1. **The compile report (the journey's valley→peak transition).** When the per-event report renders, each stamp lands with the product's one indulgent animation: scale 1.06→1 + opacity, 160ms sharp ease-out, stamps staggered 60ms apart in event order; `FAILED` stamps land last and tilt −1.5°, `GENERATED`/`REUSED` stay square. Amplitude: modest — the motion is a press, not a celebration. Everything else about the report holds the ledger register (a ruled list, chunked per event).
2. **First packet in the event feed (the peak).** A newly-arrived feed row draws its background from `--event-bg` to transparent over 600ms — ink soaking into paper. No other row-level motion anywhere.

Everything else holds the calm structure register.

## Type

Three roles. No Inter, no Roboto, no Arial, anywhere.

- **Display: Newsreader** (Google Fonts, optical sizes; stack: `"Newsreader", Georgia, "Times New Roman", serif`). Page titles, workflow name, empty-state headlines. Weights 500–600. Used with restraint — display is the only place the voice turns up. (Fraunces deliberately avoided: it is the tell-cluster serif.)
- **Body/prose: Source Serif 4** (stack: `"Source Serif 4", Georgia, serif`). Screen-optimized transitional serif — vertical axis, large x-height — chosen so a description textarea reads as writing in a well-set document. **All prose inputs (event descriptions, node prompts) are set in Source Serif 4 at `--text-base`/1.6**, same as rendered prose: writing and reading are the same surface. Weights 400/600. Harmony pairing with Newsreader: matching transitional structures (harmony, not the uncanny middle).
- **Utility/mono: IBM Plex Mono** (stack: `"IBM Plex Mono", ui-monospace, "SFMono-Regular", Consolas, monospace`). Event type names (`tweet.detected`), schema field lists, cron expressions, run ids, timestamps, table numerals, statuses/stamps, and operational UI labels (tab bar, buttons, chips). Weights 400/500/600. This is the borrowed Data-Dense-Professional voice: everything the machine reads or emits is mono; everything the human writes or reads as prose is serif.

```css
:root {
  --font-display: "Newsreader", Georgia, "Times New Roman", serif;
  --font-body: "Source Serif 4", Georgia, serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Consolas, monospace;

  /* Scale: 1.25 (major third) from 16px, rounded to whole px */
  --text-xs: 12px;    /* stamps, margin apparatus, table meta */
  --text-sm: 14px;    /* mono UI labels, table cells, field lists */
  --text-base: 16px;  /* prose: descriptions, prompts, body copy */
  --text-lg: 20px;    /* card titles, section headings */
  --text-xl: 25px;    /* page headings */
  --text-2xl: 31px;   /* workflow name (editor header) */
  --text-3xl: 39px;   /* display moments (empty states) */
  --text-4xl: 49px;   /* reserved: display-only, one per view max */

  --leading-prose: 1.6;    /* Source Serif 4 body + textareas */
  --leading-ui: 1.45;      /* mono labels, tables */
  --leading-display: 1.15; /* Newsreader ≥ --text-xl */
  --tracking-stamp: 0.08em; /* uppercase mono stamps/labels only */
}
```

## Color tokens

Generated by `palette.mjs` — **seed 246.69 (ink blue) · chroma muted · harmony complementary · light scheme only** (light-committed single look; paint `--background` explicitly, no dark variant). Regenerate only via:
`node <plugin>/scripts/palette.mjs --seed 246.69 --chroma muted --harmony complementary --scheme light`

```css
/* Generated by design-for-ai palette.mjs */
/* seed: hue 246.69 · chroma: muted · harmony: complementary */

:root {
  --neutral-1: #fcfdfd;
  --neutral-2: #f8f9fa;
  --neutral-3: #eef1f3;
  --neutral-4: #e5e8eb;
  --neutral-5: #dadfe3;
  --neutral-6: #cdd3d9;
  --neutral-7: #bdc4cb;
  --neutral-8: #a4acb4;
  --neutral-9: #909aa3;
  --neutral-10: #7e8790;
  --neutral-11: #5e6469;
  --neutral-12: #2b2e31;
  --accent-1: #fbfdff;
  --accent-2: #f5f9fe;
  --accent-3: #e7f2fc;
  --accent-4: #dbeaf8;
  --accent-5: #cce1f5;
  --accent-6: #bbd6ef;
  --accent-7: #a8c8e5;
  --accent-8: #89afd2;
  --accent-9: #6f9dc7;
  --accent-10: #608bb2;
  --accent-11: #4d667d;
  --accent-12: #222f3b;
  --accent-on-solid: #060e15;
  --amber-3: #f9efe5;
  --amber-9: #d9ae82;
  --amber-11: #765e47;
  --amber-on-solid: #130c05;
  --error-3: #ffebe9;
  --error-9: #c56c65;
  --error-11: #86534f;
  --success-3: #e6f6e6;
  --success-9: #84cc86;
  --success-11: #486e49;
  --warning-3: #f6f0e4;
  --warning-9: #ceb47e;
  --warning-11: #6f6144;
  --info-3: #e7f2fa;
  --info-9: #7aabce;
  --info-11: #4c677a;
  --background: var(--neutral-1);
  --surface: var(--neutral-2);
  --surface-hover: var(--neutral-3);
  --surface-active: var(--neutral-4);
  --border-subtle: var(--neutral-6);
  --border: var(--neutral-7);
  --border-strong: var(--neutral-8);
  --text-secondary: var(--neutral-11);
  --text: var(--neutral-12);
  --accent-bg-subtle: var(--accent-3);
  --accent-solid: var(--accent-9);
  --accent-solid-hover: var(--accent-10);
  --accent-text: var(--accent-11);
}
```

### Semantic layer (this project's law — every value is an alias onto a contrast-checked ramp step; no new hexes, ever)

```css
:root {
  /* ENTITY FAMILIES — the token-level event-vs-node distinction.
     Components reference ONLY these; never accent-*/amber-* directly. */
  --event-bg: var(--accent-3);          /* event chips, events-panel card tint, feed-row flash */
  --event-border: var(--accent-11);     /* chip + map-marker border (1.5px) */
  --event-text: var(--accent-11);       /* event type names, chip text, map labels */
  --event-solid: var(--accent-9);       /* fills only — never a sole boundary or glyph */
  --event-on-solid: var(--accent-on-solid);

  --node-bg: var(--amber-3);            /* node kind badges, node-card tint, map node fill */
  --node-border: var(--amber-11);
  --node-text: var(--amber-11);
  --node-solid: var(--amber-9);         /* fills only — never a sole boundary or glyph */
  --node-on-solid: var(--amber-on-solid);

  /* CONTROLS — probes showed neutral-8 fails 3:1 as a boundary; these pass */
  --border-control: var(--neutral-10);  /* input/textarea/select borders (3.58:1) */
  --focus-ring: var(--accent-10);       /* 2px ring, 2px offset (3.53:1) */
  --link: var(--accent-11);             /* links share the event ink — one blue, one meaning-family */

  /* RUN STATUSES (stamps: border+text in the -11; transparent bg) */
  --status-queued: var(--neutral-11);
  --status-running: var(--info-11);     /* + 6px pulse dot in info-9 */
  --status-succeeded: var(--success-11);
  --status-failed: var(--error-11);
  --status-timed-out: var(--warning-11);
  --status-cancelled: var(--neutral-11);/* + line-through label */

  /* COMPILE STATUSES (the compile-report stamps) */
  --compile-generated: var(--success-11);
  --compile-reused: var(--neutral-11);
  --compile-failed: var(--error-11);

  /* VISIBILITY (scope, not valence — no green/red) */
  --visibility-public-bg: var(--accent-3);   /* + eye/◈ glyph + "PUBLIC" label */
  --visibility-public-text: var(--accent-11);
  --visibility-private-text: var(--neutral-11); /* dashed 1.5px border + lock glyph + "PRIVATE" */

  /* BANNERS */
  --banner-error-bg: var(--error-3);    /* compile/publish failure; rule: error-9 left border 3px */
  --banner-error-text: var(--error-11);
  --banner-warning-bg: var(--warning-3);/* cycle + loop-budget notice — a WARNING, never error */
  --banner-warning-text: var(--warning-11);

  /* DERIVED MAP */
  --map-edge: var(--neutral-10);        /* edges + arrowheads (3.58:1) */
  --map-annotation: var(--warning-11);  /* loop-budget note = warning stamp */
}
```

**Entity-family usage (Phase 6 components reference tokens only):**

| Surface | Event tokens | Node tokens |
|---|---|---|
| Editor: Events panel cards | `--event-bg` card tint strip, `--event-text` type name (mono), `--event-border` chip | — |
| Editor: node-card trigger/emit chips | consumed/emitted event chips: `--event-bg`/`--event-text`/`--event-border` | kind badge (browser/asset): `--node-bg`/`--node-text` |
| Derived Map | event markers: ◈ glyph, `--event-bg` fill + 1.5px `--event-border`, mono label `--event-text` | node markers: rect, `--node-bg` fill + 1.5px `--node-border`, label `--node-text` |
| Event feed / lineage | type chips + row flash: event tokens | source-task attribution: `--node-text` |
| Runs table | emissions column chips: event tokens | task column: `--node-text` |
| Share visibility preview | public/private event rows: visibility tokens (event-ink based) | emitter names: `--node-text` |

**Redundancy law (ch08):** color is never the sole cue. Events always carry ◈ + code-style mono type; nodes always carry the kind badge word; statuses always carry the fixed-vocabulary label inside stamp form; private packets always carry the lock glyph + `PRIVATE`. Entity chips (tinted field, lowercase mono) and status stamps (bordered, uppercase, transparent) are distinct FORMS, so the info≈ink and warning≈amber hue adjacencies cannot confuse.

### Contrast evidence (computed on these hex values, 2026-08-10)

`palette.mjs` built-in report — exit 0:

```
PASS  [light] neutral-11 on neutral-2: 5.67:1 (target 4.5:1)
PASS  [light] neutral-12 on neutral-2: 12.9:1 (target 7:1)
PASS  [light] neutral-12 on neutral-3: 11.99:1 (target 4.5:1)
PASS  [light] accent-11 on neutral-2: 5.65:1 (target 4.5:1)
PASS  [light] accent-11 on accent-2: 5.65:1 (target 4.5:1)
PASS  [light] accent-on-solid on accent-9: 6.79:1 (target 4.5:1)
PASS  [light] amber-11 on neutral-2: 5.74:1 (target 4.5:1)
```

Supplementary validator (`.design-foundations` record; every DESIGN.md-committed pair) — exit 0:

```
PASS  text on background: 13.40:1 (4.5)      PASS  error-text on error-bg: 5.44:1 (4.5)
PASS  text-secondary on background: 5.88:1   PASS  error-text on background: 6.13:1
PASS  text on surface: 12.95:1               PASS  success-text on success-bg: 5.19:1
PASS  event-text on event-bg: 5.27:1         PASS  success-text on background: 5.72:1
PASS  event-text on background: 5.87:1       PASS  warning-text on warning-bg: 5.33:1
PASS  event-text on surface: 5.67:1          PASS  warning-text on background: 5.94:1
PASS  event-on-solid on event-solid: 6.77:1  PASS  info-text on info-bg: 5.24:1
PASS  node-text on node-bg: 5.34:1           PASS  info-text on background: 5.84:1
PASS  node-text on background: 5.95:1        PASS  control-border on background: 3.58:1 (3.0)
PASS  node-text on surface: 5.75:1           PASS  focus ring on background: 3.53:1 (3.0)
PASS  node-on-solid on node-solid: 9.54:1    PASS  map marker borders: 5.87 / 5.95:1 (3.0)
```

Known non-boundaries (probed, and why the aliases above are shaped as they are): `neutral-8` 2.26:1, `neutral-9`/`accent-9` 2.81:1, `amber-9` 2.00:1 against background — step-9 solids and step-8 borders are **fills/decorative ruling only**; anything that must be perceived gets an `-10`/`-11` step.

## Space, shape, depth

```css
:root {
  /* Spacing: 4px base, generous editorial rhythm */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px; --space-9: 96px;

  --radius-0: 0;     /* tables, panels, banners, rules — the ledger is square */
  --radius-1: 2px;   /* stamps, chips, badges */
  --radius-2: 4px;   /* buttons, inputs, textareas — max radius in the product */

  --rule: 1px solid var(--border-subtle);   /* the ruling system: row/section hairlines */
  --rule-strong: 1px solid var(--border);   /* panel dividers, table header rule */
  --shadow-modal: 0 8px 24px rgba(34, 47, 59, 0.18); /* accent-12 ink @ 18% — the ONLY shadow */
}
```

- Containers are **rules, not cards**: panels and rows are separated by hairlines on shared paper; no floating boxes, no elevation system. Density comes from the ruling, calm from `--space-5`+ between ruled sections.
- The one shadow belongs to the one overlay (visibility-diff modal / one-time token modal). It is ink-tinted, never pure black.
- Primary CTA (Publish): `--event-solid` fill, `--event-on-solid` text, `--radius-2`, mono 600 — the only solid-filled control on the editor. Secondary buttons (Trigger now, Create link): transparent, 1.5px `--border-control`, mono 500. Destructive (Revoke, Cancel run): text + border in `--status-failed`, never solid-filled.

## Motion

- **Timing:** micro 120ms / standard 200ms / large 300ms · **Easing:** `cubic-bezier(0.2, 0, 0, 1)` (sharp ease-out) everywhere
- **Allowed:** opacity/transform state fades; the two expressive moments (stamp landing 160ms; feed-row ink-soak 600ms); running-status pulse dot (2s opacity loop)
- **Never:** scroll-triggered reveals, parallax, ambient/looping decoration (except the pulse dot), bounce easing, skeleton shimmer faster than 1.5s, layout-shifting entrances
- **prefers-reduced-motion:** all transforms off (stamps and rows appear at final state, opacity-only ≤120ms); pulse dot becomes static

## Never (this project's tells at risk)

- **No dark mode, no cyan-on-dark, no glow.** This is a light-committed paper document; `--background` is painted explicitly.
- **No second blue meaning.** Ink blue = events (and links, which share the family). `--info-*` appears ONLY inside the RUNNING stamp. Blue never decorates chrome.
- **No hand-picked hexes.** Every color is a ramp step or an alias onto one — a new hex anywhere is drift from the lock. Contrast targets are never lowered to make a color work.
- **No step-9 solid as a sole boundary/glyph** (probed at 2.0–2.8:1): solids always carry an `-11` border or on-solid text.
- **No cards, no elevation stack, no second shadow.** Ledger Grid's temptation is to become a card grid — it must stay ruled paper.
- **No terracotta drift.** Amber stays the node family at these ramp values; warmth never spreads to backgrounds (the cream+serif+terracotta cluster is one warm background away).
- **No green/lime entity color.** Green belongs to `success` alone (candidates 4/5 died of exactly these collisions).
- **No display-type takeover.** Newsreader above `--text-2xl` appears at most once per view; the ledger's hierarchy is position and weight, not size.
- **No raw JSON as schema display** (JOURNEY law: read-only field list). No labeling drift: *publish* = compile a version; *share* = the public link. Statuses use the fixed vocabulary only.
- **Mono is a role, not a costume:** prose (descriptions, prompts, error sentences) is never set in mono.

## Open questions

- Newsreader's optical-size rendering at `--text-2xl` on low-DPI screens — verify in the Phase 6 mock; fallback position is Spectral at the same tokens.
- Stamp density in the runs table (every row carries one): if the mock reads busy, drop the border to the leading-column stamps only — form change, token values unchanged (not a lock edit).
