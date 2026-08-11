# Discovery + Design: Phase 6 - Design system + words + data surfaces

## Artifacts Found / Current State
- `DESIGN.md` — present, **Status: confirmed, token block LOCKED** (2026-08-10). Global ramps from `palette.mjs` (seed 246.69, muted, complementary, light) plus the semantic alias layer (`--event-*`, `--node-*`, statuses, banners, map). Contrast evidence anchored in-file (palette.mjs exit 0 + supplementary validator exit 0).
- `JOURNEY.md` — present. Six page specs (workflow list, editor, runs, events, share, public view), four flows, labeling laws (publish=compile, share=link, fixed status vocabulary).
- `.design-foundations/build/validate-contrast.mjs` — supplementary WCAG validator that reads DESIGN.md's committed pairs; reusable this phase as anchoring evidence.
- `.design-foundations/build/design-phase-5-discovery.md` — DW-5.3 pinned the seam: "documented so Phase 6 only references tokens."
- Target artifact `.design-foundations/build/component-specs.md` — does not exist yet.
- No `.design-foundations/plans/` directory and no `docs/workflow-conventions.md` / `docs/pillar-taxonomy.md` in this repo — the dispatch prompt inlines the Phase 6 contract, component inventory, DW items, and resolved doctrine paths. Proceeding on the inlined contract.

## Gaps
- No component-level spec exists anywhere; engineers would currently have to invent every control, string, and table treatment. This phase closes exactly that gap.
- DESIGN.md open questions (Newsreader at `--text-2xl` on low-DPI; runs-table stamp density) are **mock-phase** verifications — recorded in the spec as open flags, not resolved here (no mock is in this phase's Produces contract).
- The plan word "event **pills**" in the map inventory conflicts with DESIGN.md's shape law ("the ledger is square"; max radius `--radius-2`, chips at `--radius-1`). Resolved inside phase latitude as a form decision, not a lock edit: map event markers take the chip form (`--radius-1`), node markers the panel form (`--radius-0`) — same perceptual patterns as everywhere else (Kholmatova), no new radius value introduced.

## Gate Status
- DESIGN.md locked: YES — its aliases are the only color vocabulary this spec may use; no raw hex anywhere in component-specs.md.
- JOURNEY.md present: YES — its page specs are the component inventory's source; its labeling laws bind all microcopy.
- Prerequisites met: YES (Phases 4–5 artifacts exist; the token seam Phase 5 promised is in DESIGN.md).

## DW Verification
| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-6.1 | Every JOURNEY.md page-spec surface has component specs referencing only DESIGN.md tokens (no raw hex outside a token definition) | COVERED | Coverage table in component-specs.md mapping all 6 page specs (+ shared primitives) to spec sections; mechanical audit: `grep -E '#[0-9a-fA-F]{3,8}\b' component-specs.md` returns zero hits (the spec quotes token names only); anchoring re-check: `node .design-foundations/build/validate-contrast.mjs` exit 0 against the locked DESIGN.md. |
| DW-6.2 | Compile-failure and empty states have specified copy (actual strings, not placeholders) | COVERED | Literal strings written in-spec for: both editor panel empty states + map empty, workflow-list empty, runs empty, feed empty, share empty, public "nothing yet"; compile-failure banner + per-card inline error + compile report FAILED row; transport-failure banner; all publish disabled-reasons; visibility-diff modal; one-time token modal; revoke/rotate confirmations; "packet private" marker; load-error retry banners; 404. Verified by quoting the strings in the evidence section. |
| DW-6.3 | Derived map spec defines its layout rule concretely (layer → column mapping, spacing tokens, label rules, cycle annotation), plain SVG, no canvas library | COVERED | Map section specifies: column x-position formula from layer index, row stacking + vertical rhythm in `--space-*` tokens, marker geometry + mono-width label formula, truncation rule, edge routing (forward + cycle back-edge channel), loop-budget annotation form and string, empty state, a11y treatment — plus a complete reference SVG of the canonical tweet-workflow cycle, hand-written (plain SVG elements only). |
**All items COVERED:** YES

## Design Decisions
- **Doctrine applied:** design-systems (token tiers: DESIGN.md semantic layer is the alias tier; this spec adds the component tier as named mappings, never new values — Frost atomic decomposition orders the doc primitives → composed → surfaces), content-design (Yifrah error formula what→why→fix, no blame/no "Oops"/no exclamation marks; Redish front-loading; empty-state first-use formula; destructive-confirmation stakes-clarity), data-viz (the map and status treatments: Tufte data-ink — edges and markers only, no decoration; color never the sole cue — Knaflic/ch08 redundancy law; Munzner: position encodes layer order, containment encodes entity kind), usability (Fitts: Publish isolated top-right, destructive actions spatially separated; Nielsen #1 visibility of status for stamps/polling, #5 error prevention for confirmations, #9 for inline errors; recognition-over-recall in chip menus).
- **Voice:** three attributes — precise, calm, directive. Errors give direction, not mood; the fix for compile failures is always named as prose editing (the product's core contract, JOURNEY ai-native posture #3).
- **Form decisions inside latitude:** square-cornered switch (`--radius-1`) for the public toggle; schedule chips are neutral-family (a cron string is not an event); tab-bar active indicator is `--text` ink (blue never decorates chrome — DESIGN.md Never); inline two-step confirm for Cancel run (the one shadow belongs to the two named modals); compile report is a ruled section, not a modal.
- **Reuse:** `validate-contrast.mjs` re-run as anchoring evidence instead of new tooling; canonical tweet workflow used for every example per dispatch.

## Recommendation
BUILD
