# S5f — Two-kind e2e: browser → asset (MCP + LaTeX) → browser upload (Phase 5 exit)

> **Built, with deviations.** `page.upload(anchor, assetRef)` on the browser tool registry
> (`packages/agent/src/tools.ts`), backed by a new `Page.upload` driver primitive
> (`packages/browser/src/driver.ts`/`playwright-driver.ts`, Playwright's `setInputFiles` with
> an in-memory buffer — no temp file) traced by name/mime/size only (`session.ts`, the same
> "count or length, not content" rule `type`/`queryAll` already follow). `assets.render` is
> now wired into `buildAssetToolRegistry` (`packages/agent/src/asset-tools.ts`), the one place
> this subphase touches the asset registry, per the spec. `fake-gram`
> (`apps/testkit/sites/server.ts`) gained a file-upload form and a hand-rolled
> `multipart/form-data` parser (no new dependency) that records the uploaded bytes' sha256
> alongside `login`/`post` in the existing submissions log. The e2e itself is
> `tests/system/two-kind-e2e.test.ts` (3 tests) + `tests/system/two-kind-e2e-support.ts` (a
> new rig — neither `agent-support.ts` nor `mcp-support.ts` composes a browser *and* an asset
> executor on one engine, and bending either's single-kind contract seemed worse than one more
> file) + three hand-authored transcripts (`two-kind-scrape/report/upload.jsonl`, no live LLM
> key in this environment, documented in `fixtures/transcripts/README.md`).
>
> **A real S5a–S5e gap, fixed at its source:** `page.upload` needs to resolve an asset ref
> (`{asset_id, path, mime, sha256}`, a packet field) to raw bytes, and no such read path
> existed — `packages/assets/src/tools.ts`'s `assets.read` is LLM-facing (text-only,
> truncated, wrapped as untrusted-data) and `render.ts`'s `readCurrentAssetBytes` is private
> and path-keyed, not ref-keyed. Added `readAssetById` (`packages/assets/src/read.ts`,
> exported from the package index) — id-scoped by `(userId, assetId)`, untruncated, binary.
> Also moved `userIdForTask` out of `asset-executor.ts` (private, S5c) into
> `executor-shared.ts` (shared) — the browser executor now needs the identical
> `workflow_version_id → user_id` join to scope `page.upload`'s asset lookup, and duplicating
> a five-line query per executor was the wrong direction to go given the file already exists
> to hold exactly this kind of "both kinds need this" logic.
>
> **Deviations:**
> - **Every existing browser/asset transcript fixture needed a mechanical patch.**
>   `replayLlm` checks the recorded and requested tool-name *sets* for exact equality (sorted,
>   compared as JSON) — adding `page.upload` to the browser registry and `assets.render` to
>   the asset registry meant every transcript recorded before this subphase (`canonical-fake-
>   tweets.jsonl`, `emit-validation-retry.jsonl`, `milestone-poster.jsonl`, `milestone-
>   scrape.jsonl`, `network-tools.jsonl`, `step-budget.jsonl`, `mcp-echo.jsonl`, `mcp-
>   budget.jsonl`, `mcp-timeout.jsonl`, `mcp-credential.jsonl`) would otherwise fail replay
>   with `llm_replay_diverged` the instant this subphase's tool landed. Patched all ten with a
>   script that appends the placeholder tool entry to every recorded turn's `tools` array —
>   content-neutral (no `messages`/`toolCalls`/`args` touched), verified by re-running the
>   full S4/S5 regression suite green.
> - **Replay-determinism is checked on *normalized* PDF content, not raw `sha256`.**
>   `apps/renderer/src/sandbox.ts`'s own comment on `-Z deterministic-mode` says plainly that
>   tectonic still mints a fresh document `/ID` per compile even with it on — S5e's own
>   `latex-renderer.test.ts` happy-path test already asserts byte-stability only after
>   `normalizePdfBytes` for exactly this reason. Two independent full runs of this e2e
>   therefore have **different** raw asset `sha256`s (expected S5e behavior, not a bug) and
>   **identical** `normalizePdfBytes`-normalized content; the test asserts the latter and
>   documents the former rather than silently weakening "byte-identical" to something it never
>   was. The single-run byte-match assertion (fake-gram's recorded sha256 equals the asset's
>   own, real, un-normalized sha256) is unaffected — that comparison is within one render, not
>   across two.
> - **"The PDF is a valid PDF, non-zero page count" is a hand-rolled heuristic, not a PDF
>   library** (house rule: no new deps, and none of this workspace's existing dependencies
>   parse PDF). Verified empirically against a real render from this subphase's own renderer
>   rig that tectonic's page objects live inside compressed `/Type/ObjStm` streams — `/Type
>   /Page` never appears as plain text — so `isValidPdfWithPages`/`countPdfPages`
>   (`two-kind-e2e-support.ts`) inflate every `stream`…`endstream` region with Node's built-in
>   `zlib` and search the concatenated result. A count heuristic, not a structural parse (no
>   xref/object-graph walk) — proportionate to what the test needs to prove.
> - **This file's own "Do NOT git commit" instruction (below) was superseded by the run's
>   orchestrator instructions, which asked for a commit on this worktree branch.** Followed
>   the orchestrator; noting the conflict plainly rather than silently picking one.
>
> Registries stayed disjoint through the whole flow: no `mcp.*`/`assets.*` was added to the
> browser registry, no `page.*`/`network.*` to the asset registry —
> `mcp-registry-isolation.test.ts` (extended with `page.upload`/`assets.render` in its
> positive-control assertions) is the proof.

You are implementing subphase S5f. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 5, S5f section (the phase's exit criterion).
3. `docs/techical_plan.md` — §5 (the canonical example diagram: browser → asset → browser),
   §13.5 (`page.upload(anchor, assetRef)` and why assets must outlive the run that created
   them), §6 (`emitIfNew` dedupe — the scheduler re-fire must not double-post).
4. `docs/subphases/ROADMAP.md` — node-kind registry table, telemetry rules.

Existing code to reuse (read first): everything from **S5a–S5e**, which this subphase composes
and adds nothing new to except one tool: `packages/agent/src/tools.ts` (S4b — the browser
node's tool registry; `page.upload` is **added here** if S4b did not already add it, which it
did not, per `docs/subphases/S4b-agent-loop.md`'s deliverable 1 tool list), `packages/mcp`
(S5c's fake MCP server, `imageStub`), `packages/assets` (S5d's `assets.write`/`assets.render`,
S5e's renderer client), `apps/testkit/sites/server.ts` (fixture sites — `fake-tweets`,
`fake-gram`; `fake-gram` currently has login/post forms only and **no file-upload form**, so it
needs extending, deliverable 2).

## Scope

The phase's exit criterion, not new capability: prove the two node kinds exchange data only
through validated event packets, end to end. `fake-tweets` (cron, **browser** node) →
`tweet.detected` → **asset** node calls the S5c fake MCP server's `imageStub` tool, writes a
`.tex` via `assets.write`, renders a PDF via `assets.render`, emits `report.ready {asset_ref}`
→ **browser** node uploads it to `fake-gram` via `page.upload(anchor, assetRef)`.

## Deliverables

1. **The workflow fixture**: a three-task graph (browser → asset → browser) wired through
   `tweet.detected` and `report.ready` event types, `report.ready`'s packet schema compiled
   (or seeded via `staticSchemaGenerator` for a deterministic test) to carry the asset-ref
   fragment from S5d deliverable 5. Recorded replay transcripts for both agent-mode tasks
   (record once against live, commit the fixture, replay in CI — same discipline as every
   other agent-loop transcript since S4b).

2. **`page.upload(anchor, assetRef)`** added to the browser node's tool registry
   (`packages/agent/src/tools.ts`): resolves the asset ref (via `packages/assets`' read path),
   fetches the bytes, and drives the upload through the browser session against a file-input
   element at `anchor`. Ungated in this subphase — it is the `upload` **capability grant** that
   Phase 7 introduces (§10); build the tool shape now, exactly as S4b's other tools were built
   permissive-but-final-shaped under `AllowAllGate`. **Extend `fake-gram`**
   (`apps/testkit/sites/server.ts`) with a file-upload form (`<input type="file">` posting
   multipart to a new route, e.g. `POST /fake-gram/upload`) that records the submitted bytes'
   sha256 alongside the existing `submissions` log, the same way `login`/`post` are recorded —
   this is what deliverable 4's byte-match assertion reads.

3. **Wiring, not new mechanism**: the asset node's run composes S5c's MCP client call, S5d's
   `assets.write`, and S5e's `assets.render` in sequence inside one agent-loop transcript —
   nothing here should require a code change to any of S5a–S5e beyond deliverable 2's tool
   addition and the `fake-gram` fixture extension. If composing them exposes a real gap (an
   interface genuinely missing, not a design choice you'd rather make differently), fix it at
   its source package and say so plainly in your report — do not patch around it here.

4. **System tests** (`tests/system/`, content-named, e.g. `two-kind-e2e.test.ts`):
   - Full flow (replay): cron fires `fake-tweets` scrape → `tweet.detected` → asset node calls
     `mcp.fake.imageStub`, writes `.tex`, renders → `report.ready {asset_ref}` → browser node
     uploads → assert on **traces and events**, not internal state (the standing doctrine):
     the emitted `report.ready` packet's `asset_id` matches the asset the render produced; the
     PDF is a valid PDF (parses, non-zero page count); `fake-gram`'s recorded submission's sha256
     equals the asset's `sha256` — proving the bytes that left the harness are the bytes the
     store has, not merely that some upload happened.
   - **The asset outlives the run**: after the run completes (and, if your test harness tears
     down run-scoped state between assertions, after that teardown), the asset is still
     readable via `assets.read` / the owner-side asset query — it is not trace exhaust with a
     TTL (§13.5), and this test is what would catch a regression that accidentally scoped asset
     rows or blobs to the run.
   - **Replay-determinism**: run the full flow twice in `replay` mode → identical emitted
     packets, identical asset sha256 (the renderer's byte-stable-PDF guarantee from S5e feeding
     straight through), identical `fake-gram` submission count — no flakiness from timestamps or
     ordering leaking into content that is supposed to be normalized away.
   - Re-fire the triggering cron a second time with `emitIfNew` dedupe in place (mirrors S5g's
     triangle e2e and S4b's first-milestone test) → no double-render, no double-upload.

## Style constraints (binding)
- No new package. This subphase is fixtures, one tool addition, and tests.
- `page.upload`'s tool definition follows S4b's `ToolDef[]` shape exactly — a zod-typed
  definition plus an executor closure, nothing framework-shaped.
- New deps: none expected. Justify anything you add.

## Verification
```
rtk pnpm install && rtk pnpm build && rtk pnpm test
```
All prior tests stay green — this is Phase 5's regression gate: the entire S5a–S5e suite plus
S4's browser-agent suite must still pass unmodified except for the `fake-gram` fixture
extension and the new `page.upload` tool. Run twice; no leaked Chrome, containers, or test DBs.

## Report back
What you built, any real gap you found in S5a–S5e while wiring this together (and where you
fixed it), commands + outcomes, flakiness noticed. State plainly that this is Phase 5's exit
criterion and confirm both node kinds' tool registries stayed disjoint through the whole flow
(no `mcp.*`/`assets.*` leaked onto the browser node, no `page.*`/`network.*` leaked onto the
asset node). Do NOT git commit.
