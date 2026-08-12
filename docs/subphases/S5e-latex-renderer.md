# S5e — LaTeX renderer: sandboxed `apps/renderer`, `assets.render`, correct-and-retry

You are implementing subphase S5e. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 5, S5e section; the "LaTeX fixtures" test-infrastructure
   bullet (§ "Test infrastructure").
3. `docs/techical_plan.md` — §13.5 (document generation: LaTeX, the format table, the
   `docx`-deferred rationale), §16 Threat 7 (LaTeX as code execution), §18 decisions 11–12
   (PDF-deck labeling, `docx` deferred), §20 (tectonic stack note).
4. `docs/subphases/ROADMAP.md` — Docker/compose environment notes (this machine runs Docker),
   stack/style rules, §0.5 telemetry names.

Existing code to reuse (read first): `packages/assets` (S5d — the asset store this subphase's
images are resolved *from* and this subphase's PDFs are written *into*; `assets.write` is how a
render's output becomes a versioned asset); `packages/telemetry` (SOb — injected meter/logger,
composition-root-only init, the pattern `apps/engine`/`apps/web` already follow for
`apps/renderer` to match); `packages/core` (`AppError`). S5d is your hard prerequisite — without
it there is nowhere for a `.tex` source or a rendered PDF to live. MCP (S5c) and secrets (S5b)
are unrelated to this subphase and untouched by it.

## Scope

Two things: **`apps/renderer`**, an out-of-process, containerised, network-less worker that
compiles LaTeX to PDF; and the host-side pieces that call it — a renderer client added to
`packages/assets`, and the `assets.render(srcPath, format, opts)` tool it backs. LLM-authored
`.tex` is untrusted code in a Turing-complete language with file I/O and shell escape (§16
Threat 7) — treat the renderer with exactly the seriousness §12 gives the compiled-JS isolate,
different sandbox, identical principle: the author is untrusted, the gate is deterministic, the
executor is isolated.

## Deliverables

1. **`apps/renderer`** — a composition root (calls `initTelemetry` like every other app),
   containerised, with:
   - **`tectonic`** as the compiler; shell escape **disabled unconditionally** — not a flag
     that could be left on, a build/config choice that makes it structurally absent.
   - **No network namespace.** Tectonic's package cache is **pre-warmed into the image** at
     build time specifically so the render container needs no network at runtime — a render
     that tries to fetch a package it doesn't have fails closed, which is correct: a runtime
     network fetch is a Threat-7 hole no matter how convenient.
   - **Read-only filesystem** except a **per-render scratch directory**, freshly created per
     job and discarded after — scratch dirs are never shared across renders, even concurrent
     ones for the same task.
   - `openin_any=p` / `openout_any=p` (tectonic/TeX engine config) — no reads or writes outside
     the scratch dir, enforced by the engine's own path policy, not merely by the container
     boundary; both layers matter (defense in depth, same posture as S5g's role fence).
   - **Wall-clock and memory caps** per render, enforced by the container runtime (cgroup limits
     or the container orchestration layer, whichever this environment's compose setup makes
     the natural fit) — a breach is a **kill**, not a slow finish.
   - A narrow **package allowlist** baked into the pre-warmed cache; nothing outside it is
     reachable, network or otherwise.
   - Exit contract: exit 0 → PDF bytes returned; non-zero → the full **TeX log returned as
     structured output**, not swallowed, because deliverable 4 depends on it verbatim.

2. **The host resolves images before compilation.** Anything the `.tex` source references by
   path (`\includegraphics{...}`) must already exist in the scratch directory by the time
   `tectonic` runs — the host reads the referenced assets out of the S5d asset store and writes
   their bytes into scratch *before* invoking the renderer. **The `.tex` never names a host
   path**; whatever local filename the host chooses for a resolved image is what the LLM must
   have been told to reference (via the tool's input contract, not by discovering a host path at
   render time — there is no such discovery mechanism). This resolution step lives on the host
   side of the renderer's process boundary, not inside the container, because the container has
   no network and cannot reach the asset store's blob backend itself.

3. **`packages/assets` gains a renderer client** (`render-client.ts`) and the
   **`assets.render(srcPath, format, opts)`** tool, registered on the same `(asset, ai)`
   registry as S5d's `assets.*` tools:
   - `srcPath` resolves through S5d's `assets.read` path (must already exist as a `.tex` asset
     written by a prior `assets.write` call — the LLM authors LaTeX via `assets.write`, then
     compiles it via `assets.render`, exactly as §13.5 splits "data saving" from "document
     generation").
   - `format`: `pdf` (the primary path — `.tex` → tectonic) or a beamer-class **deck**, which is
     *also* PDF output; the API and the tool result must call it a **"PDF deck"**, never
     `.pptx` (§18.11) — this is a labeling requirement, not a rendering one: beamer already
     produces PDF, the discipline is entirely about what the tool result and any surfaced
     metadata call the file. `docx` **is rejected explicitly**: the tool returns a typed error
     whose message says "deferred, see §13.5" rather than attempting a lossy pandoc conversion
     or silently downgrading to PDF (§18.12) — a silent downgrade is worse than a clear
     rejection because it hides that the requested format was never produced.
   - On success: the returned bytes are written through `assets.write`'s path (a new
     content-addressed blob, a new `asset_versions` row) — the render tool does not return raw
     bytes to the agent's context; it writes an asset and returns the asset ref, same shape as
     every other asset-producing tool.
   - On tectonic non-zero exit: **the TeX log comes back as a tool error**, not a run failure.
     This is the reason the whole subphase exists in the shape it does — spell it out in a code
     comment near the call site, not just in this doc: LaTeX from an LLM fails routinely on
     missing packages and stray characters, and a one-shot failure would make the feature
     unusable in practice, because the odds of a first LaTeX draft compiling cleanly are low
     enough that "no retry" is equivalent to "doesn't work." The agent sees the log, corrects
     the source via another `assets.write`, and retries `assets.render` within its step budget
     — the same correct-and-retry shape S4b's emit-validation-retry already establishes for
     packet schemas, applied to a different failure surface.

4. **Container build and test mechanism.** This machine runs Docker (`docs/subphases/
   ROADMAP.md`'s environment notes), so `apps/renderer` must be buildable and runnable either
   via the root `docker-compose.yml` (a new service, matching the `engine`/`web` pattern — a
   `renderer` service on an appropriately restricted network) or via a testkit-managed container
   spawned per test run. Which mechanism owns the *sandbox hostile-corpus tests* specifically is
   left as an implementation decision — the binding constraint is that **CI must actually run
   the container for those tests to mean anything**; a hostile-corpus suite that skips whenever
   Docker is unavailable and CI happens to have Docker is fine, but a suite that silently swaps
   in an unsandboxed local tectonic invocation to keep tests green is not a renderer test at
   all, it is a tectonic test, and must not be presented as the former (same discipline S5h's
   spec applies to its Firecracker-vs-subprocess suite gating — skip loudly, never substitute
   silently).

5. **Telemetry** (§0.5, §17.2 binding names — these are already reserved in the catalogue,
   this subphase is their first call site): `render_duration_seconds{outcome}` and
   `render_sandbox_kills_total{reason}`. Kills land on the security-signals dashboard beside the
   isolate and Python rows it already reserves space for. No `.tex` source, no TeX log content,
   and no rendered-file names in any telemetry signal — content lives in the run trace under
   the user's opt-outs, same rule as everywhere else.

6. **System tests** (`tests/system/`, content-named, e.g. `latex-renderer.test.ts`,
   `latex-hostile-corpus.test.ts`), using the fixture `.tex` files named in `impl-phases.md`'s
   test-infrastructure bullet (a happy-path `.tex`, a malformed one for the retry path, and the
   hostile corpus — check them into `apps/testkit` fixtures if they don't already exist there):
   - **Hostile corpus, table-driven, extend on every new idea** (same posture as S5h's and
     Phase 6's sandbox tables): `\write18{curl ...}` → blocked (shell escape structurally
     absent, not merely refused); `\input{/etc/passwd}` → blocked by `openin_any=p`; an
     infinite macro-expansion loop → wall-clock kill; a memory-bomb document → memory-cap kill;
     a document that attempts to write outside the scratch dir → blocked. Each case asserts a
     specific `render_sandbox_kills_total{reason}` (or a blocked-not-killed outcome where the
     control is structural rather than a runtime kill — distinguish the two in the test names
     and in the metric, since "TeX Live has no shell-escape binary reachable" and "the wall
     clock fired" are different failure classes worth telling apart operationally).
   - Happy path: the fixture `.tex` → a byte-stable PDF after normalizing timestamps and
     document IDs (tectonic/PDF producer metadata, `/ID` array, `/CreationDate`,
     `/ModDate` — normalize before comparing, same rule S5h's spec applies to `.xlsx` fixtures;
     do not chase true byte-identity by accident).
   - Malformed `.tex` (missing package, stray `&`) → tectonic exits non-zero, the TeX log
     surfaces as a tool error containing the actual compiler diagnostic (not a generic
     "render failed"), a corrected retry via a second `assets.write` + `assets.render` succeeds
     within budget.
   - Image resolution: a `.tex` referencing an `\includegraphics` path that only exists as a
     prior asset → succeeds because the host wrote it into scratch before compilation; a `.tex`
     naming a host path directly (e.g. `/etc/hostname` as an image path) → fails the same way
     the `\input{/etc/passwd}` case does, proving there is no path by which a host filesystem
     name reaches the container regardless of intent.
   - Deck labeling: a beamer-class render → PDF bytes, and the tool result / any metadata calls
     it a "PDF deck" — grep the response shape for the absence of any `.pptx`-shaped claim.
   - `docx` request → typed rejection whose message contains "deferred" and "§13.5", zero
     tectonic invocations (assert via the renderer client's call count or a trace entry, not
     just the error shape — proving it never reached the sandbox is the point).

## Style constraints (binding)
- One renderer client module in `packages/assets`, one `apps/renderer` composition root — no
  render-job queue abstraction beyond what `apps/renderer`'s own HTTP surface needs; reuse
  the shape S5h's `apps/pyrunner` composition root establishes rather than inventing a second
  worker-app pattern from scratch.
- New deps: `tectonic` (system/image-level, not an npm dependency) — no LaTeX npm wrapper
  packages; the renderer client shells out or calls a thin HTTP surface over `apps/renderer`,
  whichever the container mechanism (deliverable 4) settles on. Justify anything else you add.
- `docx` gets no partial implementation of any kind — not even a stub that degrades to PDF.
  The rejection is the whole feature for that format in this subphase.

## Verification
```
rtk pnpm install && rtk pnpm build && rtk pnpm test && rtk pnpm lint
```
All prior tests stay green. With Docker available: bring up `apps/renderer` via whichever
mechanism deliverable 4 settled on and confirm the hostile-corpus suite actually runs against
the containerised worker (not a bare local `tectonic`) — state this explicitly in your report,
the same way S5h's report must state which sandbox backend ran. Run twice; no leaked renderer
containers or scratch directories.

## Report back
What you built, deviations + why (including the container mechanism you chose for deliverable
4 and why), commands + outcomes, flakiness noticed. Confirm which sandbox controls are
structural (shell escape absent) versus runtime-enforced (wall clock, memory) and list every
one, the same way S5h's report must list every guest-host channel. Do NOT git commit.
