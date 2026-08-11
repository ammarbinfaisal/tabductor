# Discovery + Design: Phase 5 - Design DNA + tokens

## Artifacts Found / Current State
- No DESIGN.md at project root — this phase creates and locks it.
- JOURNEY.md present at root (Phase 4 output): page specs for all six surfaces, loyalty-loop journey, labeling laws (`publish` vs `share`; statuses `generated | reused | failed`; event types render in code style), emotion curve (valley at Publish-fail, peak at first sampled packet).
- Product context: `docs/event-centric-model.md`, `docs/sharing.md` (read by Phase 4; JOURNEY.md carries the design-relevant distillate).
- Plugin scripts present and runnable: `dealer.mjs` (composition dealer), `palette.mjs` (OKLCH token generator with built-in WCAG report, exit 2 on failure).

## Gaps
- No plan file under `.design-foundations/plans/` — as in Phase 4, the dispatch prompt carries the phase contract inline and is treated as the authoritative spec.
- `docs/workflow-conventions.md` and `docs/pillar-taxonomy.md` do not exist in this repo; doctrine resolved from the explicit plugin paths in the dispatch prompt.
- Non-interactive dispatch: the design-dna converge step cannot ask the user. The user already fixed the direction at plan time ("calm technical document") and delegated the free axes ("your judgment"); convergence is executed under that delegation and recorded here.

## Gate Status
- DESIGN.md: absent — this phase IS the locking phase; no prior lock to honor.
- JOURNEY.md: present — prerequisite MET.
- Doctrine: design-dna, archetypes, foundations, fonts (+appendix), color (+ch09) all read.

## DW Verification
| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-5.1 | Every text/background pair passes WCAG AA (≥4.5:1 body, ≥3:1 large/non-text) validated on actual hex values | COVERED | `palette.mjs` contrast report exit 0 (PASS on all built-in pairs), plus a supplementary validator script computing WCAG ratios for every additional pair DESIGN.md commits to (entity-chip text on chip bg, status text on tinted bg, functional borders) — both outputs pasted into DESIGN.md. |
| DW-5.2 | Semantic aliases (`--background`, `--surface`, `--text`, muted text, borders, `--accent-*`) + full type scale (`--text-xs`…`--text-4xl`) + spacing scale | COVERED | Structural inspection of DESIGN.md token block: palette.mjs semantic-alias output pasted verbatim (background/surface/hover/active, border ×3, text ×2, accent ×4) + type-scale tokens xs…4xl + spacing scale tokens, all as CSS custom properties. |
| DW-5.3 | Event-vs-node distinction as named token families with defined roles, documented so Phase 6 only references tokens | COVERED | DESIGN.md defines `--event-*` and `--node-*` families (bg/border/text/solid/on-solid roles) aliased onto the two contrast-checked accent ramps, with a usage table naming every surface that consumes them (event chips, node kind badges, map, events panel) and a shape-redundancy rule (color never the sole cue). |

**All items COVERED:** YES

## Design Decisions

### Pins (from the user-confirmed brief; non-interactive dispatch → pins come from the brief only)
- `family=editorial-minimalism` — "calm technical document. Light, editorial, generous spacing — a specification you annotate" is Editorial Minimalism's definition (quiet authority, rules/hairlines instead of cards). Archetype behind it: Sage (measured, precise; muted palette, serif or technical type) — primary family per archetypes.md Part C.
- `chroma=muted` — "calm" fixes the chroma character.
- Free (dealt): discipline, hue, signature. Fonts are never dealt; type pairing is this phase's judgment call per the brief.

### The deal
`node dealer.mjs --project tabductor --date 2026-08-10 --candidates 5 --pin family=editorial-minimalism --pin chroma=muted` (ledger: `.design-foundations/used-dna.json`, seed `tabductor|2026-08-10|0|pin:chroma=muted,family=editorial-minimalism`). Five hands, disciplines pairwise distinct, hues golden-angle spread. `palette.mjs` run per candidate (muted, complementary) before critique — all five exit 0.

### Critique (criteria-bound, all five before any choice)
1. **pink 331.68 · Poster Bleed · single-diagonal** — Strongest: unmistakably distinct. Weakest: register fit fails — "minimal copy pinned to edges, center vacant" cannot host a three-panel editor, runs table, or event feed (content pressure: dense tables + prose editing). Tells: none. Marked weak.
2. **lime 109.18 · Split Stage · accent-scarcity** — Strongest: the 38/62 packed-vs-calm split genuinely maps to the editor (authoring panels vs derived Map). Weakest: invented structure on the single-surface pages (list, runs, events); dealt lime has no named content cue (green/lime guard); the accent-scarcity signature is unexecutable — the brief REQUIRES two accent families running through chips, map, and panels. Marked weak.
3. **blue 246.69 · Ledger Grid · duotone-images** — Strongest register fit of the set: "ruled paper — hairlines structure everything" is nearly literal for "a specification you annotate," and the ledger discipline serves the runs table, event feed, schema field lists, and compile report natively; variance 2 = the calm structure register the brief fixes. Muted ink-blue (#6f9dc7 solid, #4d667d text) + amber complement (#d9ae82) reads as ink + highlighter on paper. Distinctiveness: nearest generic cluster is the cool-blue SaaS dashboard — countered by serif prose-first type, warm-white paper ground, rules-not-cards, and the stamp apparatus. Tells: editorial-minimalism × ledger-grid is a legal cell (the ledger-grid bans are cinematic-dark and terminal-mono); blue-text-is-links convention managed by giving links the same ink family as events, consistently. Signature `duotone-images` unexecutable (no imagery exists in the product) → swap required at converge.
4. **orange 24.2 · Editorial Spread · border-interrupt-headings** — Weakest of the set: muted orange lands on terracotta (accent-9 #c56b66) — one step from the cream+serif+terracotta escape-hatch tell cluster, and nearly identical to error-9 #c56c65, a fatal accent/error collision for a product whose peak surfaces are status reports. Display-type-first hierarchy fights a data-editing hub. Marked weak.
5. **green 161.71 · Monolith Center · box-drawing-borders** — accent-9 #84c9a6 collides with success-9 #84cc86 (entity color ≈ success status); monolith-center (sparse, one centered mass) contradicts the content everywhere; dealt green has no content cue. Box-drawing borders pull terminal-ward, against "well-set document." Marked weak.

### Converge
**Pick candidate 3 — "Ruled Ink"** — with one legal converge-time swap: signature `duotone-images` → `marginalia-stamps` (another deck signature: "small rubber-stamp-style status marks live in the margins"). The swap is both executable and lands exactly where the brief says the feeling lives: the compile report's `generated | reused | failed` per-event marks are the journey's valley→peak transition. Composition cell untouched (never swapped — that would be a re-deal). Re-present critique line for the swapped spec: register fit unchanged (stamps are the archetypal calm-structure expressive moment — a document annotated by its machinery); no new tells (stamp marks are not the numbered-section-markers copy tell); distinctiveness improved (a stamped ledger is a fingerprint no template carries).

### Harmony choice
`--harmony complementary` — the brief's event-vs-node requirement needs a SECOND accent family at token level; the complement (amber 66.69) is the farthest structural position from the ink base, and muted chroma keeps a complementary pair gentle (ch09: complementary schemes are calm when desaturated). Split/triadic rejected: their secondaries land on the functional hues (error 25 / success 145), recreating exactly the collision that sank candidates 4 and 5.

### Entity family assignment (DW-5.3)
- `--event-*` ← ink/accent ramp (blue 246.69). Events are the contracts — the ink of the specification; the ◈ glyph and code-style type carry shape redundancy.
- `--node-*` ← amber complement ramp. Nodes are the machinery that acts; warm advances (ch09 warm/cool depth), so the actors sit forward of the contracts on the Map.
- Near-hue adjacency with functional colors (info 240 ≈ event ink; warning 85 within 18° of node amber) is resolved by FORM, not hue: entity chips are tinted-field chips (step-3 bg, step-11 text, mono type), statuses are stamp-form marks (bordered, uppercase, letterspaced, transparent bg) — plus labels always present (JOURNEY labeling law; color never the sole cue, ch08).

### Type pairing (brief: characterful display + complementary body + utility mono; no defaults)
- Display: **Newsreader** (opsz axis, editorial voice; chosen over Fraunces deliberately — Fraunces is the tell-cluster serif).
- Body/prose: **Source Serif 4** — screen-optimized transitional serif (vertical-axis, large x-height: ch03 medium-form fit) that makes a description textarea read as a well-set document. Harmony pairing: matching transitional structures with Newsreader (appendix rule: harmony via structure, not "two nice fonts").
- Utility/mono: **IBM Plex Mono** — event type names, schema field lists, cron expressions, run ids, statuses, table numerals, and operational UI labels (tabs, buttons). Deliberate-contrast role against the serifs.

### Concision
Palette generated by `palette.mjs` (not hand-rolled); light scheme only (brief: light-committed single look; doctrine does not demand a dark variant); semantic layers defined as aliases over the generated ramps rather than new hexes, so every color in DESIGN.md traces to a contrast-checked ramp step.

## Recommendation
BUILD
