# Discovery + Design: Phase 4 - Discover (JOURNEY.md)

## Artifacts Found / Current State
- No JOURNEY.md, no DESIGN.md at project root — this phase creates the first design artifact.
- All six surfaces already exist as Next.js routes (`apps/web/src/app/`): `/workflows`, `/workflows/[id]`, `/workflows/[id]/runs`, `/workflows/[id]/events`, `/workflows/[id]/share`, `/s/[token]` (+ `/s/[token]/runs`, `/s/[token]/runs/[ref]`, `/s/[token]/events`). This is a redesign of live routes, not greenfield.
- Authoritative product docs read: `docs/event-centric-model.md` (events as entities, prose-only authoring, publish-time LLM schema compiler, compile report, derived topology, panel editor decision §6), `docs/sharing.md` (share token model, visibility manifest, three tiers, visibility preview/diff, error classes, public routes).
- Canonical example grounded in repo fixtures: the `fake-tweets` tweet-scraping workflow (`tweet.detected`, scraper → ranker → decision loop; `docs/impl-phases.md`, `docs/subphases/S4b-agent-loop.md`).

## Gaps
- No plan file exists under `.design-foundations/plans/` — the dispatch prompt carries the full phase contract (surfaces, DW items, doctrine) inline and names itself authoritative; treated as the phase spec.
- `docs/workflow-conventions.md` does not exist in this repo; proceeded on the dispatch prompt's gate vocabulary.
- No user research exists (single-user local product). Journey-map emotion curve and IA labels will be marked UNGROUNDED / NOT VALIDATED per journey doctrine's theater rule (NN/g; Watermark 2023) rather than fabricated.

## Gate Status
- DESIGN.md: not present — not a prerequisite for the Discover stage (JOURNEY.md precedes DESIGN.md in this plan's lifecycle). No lock to honor or violate.
- JOURNEY.md: absent — this phase produces it.
- Prerequisites: product context + repo docs present. MET.

## DW Verification
| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-4.1 | `## Page specs` has a complete entry per surface (workflow list, editor, runs, events feed, share management, public view) | COVERED | Structural inspection of JOURNEY.md: six `###` entries under `## Page specs`, each with Purpose / Entry points / Content blocks / States / Primary CTA / Exit (journey doctrine page-spec template). Verified by grep count = 6. |
| DW-4.2 | Publish-failure path (compile report with failed event → edit description → republish) specified as a journey step with its own flow | COVERED | A dedicated named flow under `## Flows` ("Publish, fail, repair, republish") with entry, decision nodes, error states, success state; also surfaced in the journey map phase table and the editor page spec's error state. Verified by grep for the flow heading. |

**All items COVERED:** YES

## Design Decisions
- **JTBD school: Moesta Switch interview** (single school per project — journey doctrine rule; Moesta recommended as most actionable). Actor's old solution: hand-wired automation scripts / canvas-based workflow tools that demand JSON schemas and drawn edges.
- **Journey decision model: McKinsey loyalty loop (2009)** — this is a tool with an iterate-publish-watch loop, not an acquisition funnel; the loyalty loop's post-purchase loop maps to the author's evolve-republish cycle. No linear funnel (doctrine rule).
- **IA: task-based organization scheme (Rosenfeld/Morville), hub-and-spoke structure** — the editor is the hub of each workflow; runs/events/share are spokes. Global nav stays minimal (Hick–Hyman 1952: few, well-labeled top-level choices). Sitemap ≠ IA caveat flagged; card sort / tree test NOT VALIDATED (single user).
- **ai-native framing:** the substrate IS fixed (stable pages → journey mapping legitimately applies; ai-native orienting question A), but publish is an agentic compile step: design the **goal contract** (prose in → compiled schema out), make the compiler **inspectable** (schema as a field list, never raw JSON), design **failure and repair** (per-event compile report, atomic failure, edit-description → republish loop), and keep a **deterministic exit** (the ajv gate, "Trigger now", stub packets). All principle-derived (Dibia agent-UX; Smashing 2024) — canon gap marked in the deliverable per doctrine.
- **Usability laws cited down** where used: Hick's law for nav and trigger-chip staging, Fitts's law for publish CTA placement and destructive-action separation, Cowan ~4±1 for chunking the compile report.
- No marketing spine — no marketing surface exists; section omitted as N/A (doctrine permits: use the layers the problem calls for).
- Concision: JOURNEY.md uses the doctrine template verbatim; canonical tweet-workflow copy reused across sections instead of inventing parallel examples.

## Recommendation
BUILD
