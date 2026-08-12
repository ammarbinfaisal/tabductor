# S5d — Asset store: paths, versions, write grants, public asset resolution

> **Built, with deviations.** Migration `0012` (a parallel agent, S5b, took `0011` for
> `packages/secrets` in its own worktree — the two schema.ts blocks are kept separate and
> merge cleanly). New package `packages/assets` (`paths.ts`, `grants.ts`, `tools.ts`); the
> asset-ref fragment lives in `packages/core/src/asset-ref.ts` (`ASSET_REF_SCHEMA`); the
> public route is `apps/web/src/app/s/[token]/assets/[id]/route.ts`; the derivation query is
> `publicAssetRef` in `packages/engine/src/public-read.ts`.
>
> Deviations from the letter of this doc, each argued in the report:
> - **`assets.*` tools are not wired into a live agent loop.** S4b's loop
>   (`packages/agent/src/loop.ts`) builds its tool list from a browser `RunSession`
>   unconditionally; there is no `(kind, mode)`-keyed tool-registry seam yet for
>   `AssetExecutor` to plug into. `buildAssetToolRegistry` in `packages/assets/src/tools.ts`
>   produces the tool list — same `{name, description, parameters, execute}` shape as
>   `packages/agent/src/tools.ts`'s `AgentTool`, duplicated rather than imported to avoid a
>   package cycle (S5c's merge needs `packages/agent` to import `packages/assets`) — and is
>   tested by calling `.execute()` directly. S5c is where an asset-node loop exists to call it.
> - **The asset-ref fragment is registered on both ajv instances (`packet-schema.ts`'s
>   runtime validator, `graph.ts`'s publish-time strict gate) but the live schema compiler
>   inlines the shape rather than emitting `$ref`.** `schema-generator-llm.ts`'s
>   `SCHEMA_SYSTEM_PROMPT` forbids `$ref` outright (no `$ref`/`allOf`/`anyOf`/…), so a
>   compiled schema that names an asset field gets the literal fragment shape inlined, shown
>   to the model in that same prompt. The `$ref` registration is real and exercised (a
>   hand-authored/test schema using `$ref: "assetRef"` compiles under both instances) — it
>   just is not the path the live generator takes.
> - **`minimatch` is a new dependency**, for `asset_write_grants.path_glob` matching only —
>   the spec's own style constraints call this acceptable when hand-rolling glob semantics
>   (`**` across segments, character classes) would be the larger risk, which it is for a
>   write-authorization gate.
> - **The public route returns the standard `Response`, not `NextResponse`.** Nothing here
>   needs `next/server` (no cookies, no redirect helper), and returning it kept the route
>   resolvable from a system test importing it directly under the root workspace's
>   `tsconfig.json` (`next/server`'s types are shaped for `apps/web`'s own bundler
>   resolution and are not resolvable under the root's Node-style resolution).
>
> `pnpm install && pnpm build && pnpm lint && pnpm test` green twice (207 tests, 46 files, 1
> skipped — up from the prior 175/44/1). See the full report for the write-grant
> default-allow resolution, the rate-limit outcome-label choice, and one transient failure
> caused by a parallel agent racing the shared Postgres migration-template database (not a
> bug here; a clean retry passed).

You are implementing subphase S5d. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 5, S5d section.
3. `docs/techical_plan.md` — §13.5 (asset store: namespace, tools, versioning), §14 (`assets`,
   `asset_versions`, `asset_write_grants` schemas), §16 Threat 8 (path traversal), §18 decision
   14 (writes grant-scoped, reads open).
4. `docs/sharing.md` — §4.4 (public asset resolution — the forward contract this subphase
   fulfills), §5.1–5.2 (the `/s/<token>/assets/<id>` route and its headers), §5.3 (rate limits).
5. `docs/subphases/ROADMAP.md` — node-kind registry table (binding: `assets.*` lives on
   `kind=asset` only), stack/style rules.

Existing code to reuse (read first): `packages/browser/src/blob-store.ts` (`BlobStore`,
`createMinioBlobStore` — content-addressed `sha256:<hex>` refs, `meta.mime` becomes
`Content-Type`; assets go through THIS interface, do not build a second one; `presignedGetObject`
exists on the underlying minio client if the public route wants to redirect rather than proxy —
decide at implementation, see deliverable 6); `apps/web/src/app/api/blobs/[ref]/route.ts` (the
owner-side blob route — the public route is its sibling with a stricter posture, same
`artifacts`-lookup-then-store-fetch shape); `apps/web/src/server/trpc.ts` (`shareProcedure`,
`ShareContext`, `findShareByToken`, `createRateLimiter` — reuse the rate-limit primitive and the
token-resolution helper, not `shareProcedure` itself, since the public asset route is a Next.js
Route Handler, not a tRPC procedure); `apps/web/src/server/routers/public.ts` and
`packages/engine/src/{queries.ts,public-read.ts}` (the filter-in-SQL discipline — sharing.md's
central rule, binding here too); `packages/core/src/{errors.ts,config.ts}` (`AppError`, the
`optionalSetting`/env-schema pattern); `packages/engine/src/{packet-schema.ts,schema-generator.ts,
schema-generator-ai.ts}` (the ajv instances and the LLM schema-compiler seam this subphase must
feed a reusable fragment into). **S5a must land first** — the executor/tool registry keys on
`(kind, mode)`; `assets.*` registers on that registry, it does not stand up a new one.

## Deliverables — new package `packages/assets`

1. **Migration** (drizzle, §14, additive — use the next free migration number):
   `assets(id, user_id, path, mime, size, sha256, blob_ref, current_version, created_at,
   updated_at)` with `unique(user_id, path)`; `asset_versions(asset_id, version, blob_ref,
   sha256, size, run_id, created_at)`; `asset_write_grants(task_id, path_glob)`.

2. **Path handling** (`paths.ts`) — asset paths come from LLM output (§16 Threat 8), so this is
   the module the whole package trusts. `normalize(userId, rawPath) → string | reject`:
   Unicode-normalize (NFC) *before* any traversal check, not after (an NFC-only-after check lets
   combining-character sequences reassemble into `..` post-check); reject leading `/`, `..`
   segments in any position, backslashes, null bytes, and percent-encoded traversal
   (`%2e%2e`), whether or not the caller pre-decoded; resolve the surviving path within
   `/users/<user_id>/...` and re-verify the resolved path still starts with that root (belt and
   suspenders against a normalization bug rather than trusting the reject list alone). No
   filesystem symlinks exist against a MinIO-backed store, but validate the shape anyway — a
   future filesystem-backed `BlobStore` must not reopen this threat by inheriting an
   under-validated path type. **Table-driven corpus, extend on every new idea** — same pattern
   as `blob-store.ts`'s `REF_PATTERN`/`AppError` check and S5h's extraction-path validation
   (`docs/subphases/S5h-python-compute.md` deliverable 7, which reuses this exact module):
   `../../etc/passwd`, `/etc/passwd`, `a/../../b`, `a/..%2f..%2fb`, NFKD-normalized dot
   sequences, a bare `..`, an empty path, a path that is only whitespace.

3. **Tools** (`tools.ts`, registered on the `(asset, ai)` tool registry from S5a/S5c —
   **nowhere else**; there is no `assets.*` name on the browser or decision registries):
   - `assets.write(path, content, mime)` — text formats (md, tex, json, csv, txt, html);
     normalizes the path (deliverable 2), checks the write-grant glob (deliverable 4), puts the
     content through `BlobStore.put`, upserts the `assets` row (`current_version`, `sha256`,
     `size`, `blob_ref`) and appends an `asset_versions` row. **Overwrites never destroy the
     prior blob** — this falls out of `BlobStore` being content-addressed, not from extra code:
     the old `blob_ref` is still a valid `sha256:<hex>` key in the bucket and the old
     `asset_versions` row still points at it; say this plainly in a code comment, since it is a
     property of the store rather than a check anyone writes.
   - `assets.append(path, content)` — reads the current blob (if any), concatenates, and writes
     through the same path as `assets.write` (a new content-addressed blob, a new version row);
     there is no partial-object append primitive on `BlobStore` and none is needed.
   - `assets.read(path, range?)` — paginated for large files; read is **not** grant-scoped
     (§13.5: reads open across the user's workflows — a cross-workflow report is a core use
     case).
   - `assets.list(glob)` — discovery, scoped to the caller's `user_id`, not grant-scoped (same
     reasoning as read).
   - Every tool result that touches content follows the untrusted-data wrapping convention S5c
     establishes for MCP results (label + delimit before it enters context) where the content
     did not originate with this task's own prior writes.

4. **Write-grant enforcement.** `assets.write`/`assets.append` look up `asset_write_grants` for
   the calling task. **This is real now, not deferred** — `impl-phases.md`'s S5d bullet and its
   own test (`write outside grant glob → denied`) require it, and S5h's extraction path already
   assumes it exists and enforces it. Resolve an apparent tension with the design docs
   explicitly: `techical_plan.md`'s Phase 7 section says asset write grants "tighten from 'any
   path in the user namespace' to the per-task `path_glob`," which reads as if grant checking
   itself were a Phase 7 addition. It is not — read alongside §0's permissive-until-Phase-7
   doctrine and S5c's `checkMcpCall`/`AllowAllGate` pattern, the tightening Phase 7 performs is
   the **default for an ungranted task**, not the glob-matching mechanism. Build it this way: a
   task with **at least one** `asset_write_grants` row may write only to paths matching one of
   its globs (glob matching via a small hand-rolled matcher or a minimal dependency — see Style
   constraints); a task with **zero** grant rows may write anywhere under its own user
   namespace, mirroring the AllowAllGate default everywhere else in the plan. Phase 7 is what
   flips the ungranted-task default from allow to deny, exactly as it flips MCP tool-list
   membership and secret-grant enforcement. Seed `asset_write_grants` rows directly in tests
   (there is no authoring UI yet, same as S5c's `mcp_servers`/`secret_grants` fixtures).

5. **Asset refs in packets — a reusable schema fragment (§18.2).** Export a canonical JSON
   Schema for `{asset_id, path, mime, sha256}` — `packages/core` is the right home (both
   `packages/assets` and `packages/engine` already depend on it without a cycle) — and wire it
   into the publish-time schema compiler so an event description like "a link to the generated
   PDF" compiles to this exact shape instead of every node's schema inventing its own. Two
   concrete touch points: register the fragment with `packet-schema.ts`'s runtime ajv instance
   and `graph.ts`'s strict publish-time ajv instance (`ajv.addSchema(fragment, "assetRef")`, so
   a compiled schema may `$ref` it), **and** hand the fragment's literal shape to
   `schema-generator-ai.ts`/`schema-generator-llm.ts`'s prompt context so the model is told to
   reference it. Whether the compiled output actually emits a `$ref` (requiring both ajv
   instances to have the schema registered) or the generator inlines the literal shape it was
   shown (no `$ref` plumbing, simpler, slightly more duplication in stored schemas) is an
   implementation decision — either satisfies "the model does not invent its own shape per
   node"; note which you picked and why in your report.

6. **Public asset resolution + `/s/<token>/assets/<id>`** (`sharing.md` §4.4 — a forward
   contract S2d already promised, landing here). A new read model,
   `publicAssetRef(db, {workflowId, publicTypes, assetId})` in `packages/engine/src/queries.ts`
   or `public-read.ts` (match whichever already holds the other `public*` functions), that
   **filters in SQL** per sharing.md §4.1's central rule: join `events → runs → tasks →
   workflow_versions` to scope by `workflowId`, filter `type = ANY(publicTypes)`, and check
   whether the packet's JSON contains an asset ref whose `asset_id` matches — a recursive
   `jsonb_path_exists(packet_json, '$.**.asset_id ? (@ == $id)', ...)` (asset refs are not
   guaranteed to sit at a fixed top-level key) is one correct shape; adjust to what the fragment
   convention from deliverable 5 actually produces. No asset visibility table, no cache — this
   query is the whole mechanism (§14: "asset visibility is derived... there is no share-grant
   table to keep in sync").

   The route itself: `apps/web/src/app/s/[token]/assets/[id]/route.ts`, mirroring
   `api/blobs/[ref]/route.ts`'s two-check shape (row lookup, then store fetch) but resolving the
   share token first via `findShareByToken` (reuse, do not re-derive) and gating on
   `publicAssetRef` rather than an `artifacts` lookup. On success, headers per sharing.md §5.2:
   `Content-Disposition: attachment` (always — never `inline`, unlike the owner route's
   image-mime carve-out), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`,
   and `Content-Type` restricted to a narrow MIME allowlist (anything else served as
   `application/octet-stream`). Whether the route proxies bytes through `BlobStore.get` (keeps
   these headers authoritative on our origin) or 302-redirects to a MinIO presigned URL
   (`presignedGetObject`, not currently exposed on `BlobStore` — offloads bandwidth but pushes
   header authority onto MinIO's response, which needs `respHeaders` on the presign call to
   carry them) is an implementation decision; if you redirect, prove the headers still land on
   the actual bytes the browser receives, not just on the 302. Rate limiting matches S2d's
   shape exactly: reuse `createRateLimiter` for a per-share and a per-IP/client bucket at the
   same capacities `trpc.ts` already uses, checked before the row lookup so guessing asset ids
   costs the guesser. Unknown share, revoked share, unknown asset, and an asset not referenced
   by any public packet are **all** a 404 — indistinguishable, same as every other public route.

7. **Telemetry** (§0.5, §17.2 binding names): asset read/write counters
   (`asset_writes_total{outcome}` / `asset_reads_total{outcome}` — not yet in the §17.2
   catalogue; note the addition in your report so the catalogue doc can be updated, per its
   "rename via doc change, not drive-by" rule, which implies additions get the same courtesy)
   and — the one that matters most — `share_asset_reads_total{outcome=ok|denied|not_found}`
   (§17.2 already reserves this name from S2d; this subphase is where it gets its first real
   call site, at the public asset route).

8. **System tests** (`tests/system/`, content-named, e.g. `asset-store.test.ts`,
   `asset-path-traversal.test.ts`, `public-asset-route.test.ts`):
   - Traversal corpus from deliverable 2, table-driven — all rejected, none reach `BlobStore`.
   - Write outside an existing grant glob → denied, `asset_writes_total{outcome=denied}`; a
     task with no grant rows → write anywhere under its namespace succeeds.
   - Overwrite → new `asset_versions` row, `current_version` bumped, the **old** version's
     `blob_ref` still resolves through `BlobStore.get` (proves the "overwrites never destroy"
     claim rather than asserting it).
   - Asset ref round-trips through an event packet: an asset node emits a packet containing one,
     downstream `event_defs.packet_schema_json` (compiled per deliverable 5) validates it.
   - Public resolution: an asset referenced only by a private-type packet → 404 from the route
     and absent from `publicAssetRef`'s result set (assert the read model directly, not just
     the response, per sharing.md §4.1); the same asset once its packet's event type is marked
     public and republished → 200, correct bytes, correct headers; revoked share → 404.
   - Rate limit: burst past the per-share bucket on the asset route → `429`,
     `share_asset_reads_total{outcome=denied}` (or whatever outcome label you choose for a
     rate-limited hit — keep it consistent with `share_views_total`'s `rate_limited` label if
     you add a fourth outcome, and say which you picked).

## Style constraints (binding)
- `packages/assets` holds the store logic only in this subphase — the LaTeX renderer client
  (`assets.render`) is S5e's addition to the same package, not built here.
- No generic path-security library; the traversal check is one small module, hand-written and
  table-tested, matching `blob-store.ts`'s existing crude-is-fine posture.
- New deps: none expected for the store itself. A minimal glob-matching dependency for
  `path_glob` (e.g. `minimatch` or `picomatch`) is acceptable if hand-rolling glob semantics
  would be the larger risk — justify the choice; nothing in the workspace pulls one in today.
- No public read path that fetches first and redacts afterward (`ROADMAP.md`'s binding rule) —
  `publicAssetRef` is a gate, not a filter applied to an already-fetched row.

## Verification
```
rtk pnpm install && rtk pnpm build && rtk pnpm test
```
All prior tests stay green, including the entire S2d/U0.5 public-read suite (public asset
resolution must not touch how packets or graphs are gated) and S5c's registry-isolation test
(assert it still holds with `assets.*` in the mix). Run twice; no leaked MinIO buckets or test
DBs.

## Report back
What you built, deviations + why (including the write-grant tension resolution and which
`$ref`-vs-inline choice you made for the asset-ref fragment), commands + outcomes, flakiness
noticed. Do NOT git commit.
