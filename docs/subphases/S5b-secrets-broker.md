# S5b — Secrets broker: envelope encryption, fill/inject, origin binding

You are implementing subphase S5b. Read, in order:
1. This file (authoritative).
2. `docs/impl-phases.md` — Phase 5, S5b section.
3. `docs/techical_plan.md` — §16 Threat 4 (the whole encryption design and the residual-threat
   controls), §14 (secrets tables), §13 last paragraph (MCP injection point).
4. `docs/subphases/ROADMAP.md` — stack/style rules; §0.5/§17.2 telemetry names.

Existing code to reuse (read first): `packages/browser` (driver, `openRunSession`, trace
recorder), `packages/db`, `packages/policy`, `packages/telemetry` (SOb), testkit
(`fake-gram` login form is your fill target). Built BEFORE S5c (MCP) and S5d (assets) so no
credential ever passes through a prompt even in the permissive phases. Tier 2 (user-wrapped)
is Phase 7 — NOT yours. `secret_grants` *enforcement* is Phase 7; the table exists now.

## Deliverables — new package `packages/secrets`

1. **Migrations** (drizzle, §14): `secrets(id, user_id, name, description, tier[server|user_wrapped],
   ciphertext, nonce, dek_wrapped, kek_ref, allowed_origins[], created_at, rotated_at)` with
   `unique(user_id, name)`; `secret_grants(task_id, secret_name)`;
   `secret_access_log(run_id, secret_name, action, anchor, ts)` — the log **never has a value
   column**; there is nothing to accidentally write into.

2. **Envelope encryption** (`crypto.ts`): per-secret random 32-byte DEK; value sealed with
   XChaCha20-Poly1305 (`sodium-native` `crypto_secretbox_*`); DEK wrapped by a KEK behind a
   `KeyWrapper` interface (`wrap(dek) → {wrapped, kekRef}`, `unwrap(wrapped, kekRef) → dek`).
   One implementation now: `fileKeyWrapper(path)` reading a local KEK file (dev/test); KMS is a
   later config swap behind the same interface — design for it, do not build it. Do not
   hand-roll primitives beyond composing libsodium calls.

3. **The broker** (`broker.ts`) — its public interface is EXACTLY two methods:
   - `fill(runId, secretName, anchor): Promise<{ok: true}>`
   - `injectIntoMcpArg(runId, secretName): Promise<OpaqueHandle>` (resolved host-side inside
     the S5c MCP client; the handle carries no plaintext — it is a lookup token the broker
     redeems in-process).

   **There is no `get(name): string` — anywhere, ever.** That absence is the primary control
   (§16). Decryption happens only inside `fill`/redeem; plaintext lives in a `sodium-native`
   secure buffer for exactly one use and is zeroed (`sodium_memzero`) in a `finally`.

   `fill` performs, in order, all of:
   - **Origin binding**: the page's *live origin at fill time* (ask the driver, not the task
     config) must match one of the secret's `allowed_origins`; mismatch → refuse, trace
     `policy_denied`, log `denied_origin`.
   - **Target validation**: anchor must resolve to `input[type=password|email|text]` in a
     same-origin frame; refuse hidden fields, `contenteditable`, cross-origin iframes.
   - **Rate limit**: max fills per run (default 3, task-overridable downward only); breach
     fails the run — a loop of fills is character-probing exfiltration, not a login (§16).
   - The keystroke insertion itself goes through a new driver-internal method
     (`packages/browser`, e.g. `insertTextRaw(locator, text)`) that is NOT part of any agent
     tool surface — the agent tool is `secrets.fill(name, anchor)` (wired into the registry
     in S4b's registry structure), and its **tool-result serializer returns `{ok: true}` and
     nothing else** — the return type has no field a value could occupy.
   - Every attempt (success or refusal) appends to `secret_access_log` (action, anchor,
     never the value) and increments
     `secret_fills_total{outcome=filled|denied_origin|denied_target|rate_limited}` (§17.2).

4. **Leak lint**: a lint gate (ESLint `no-restricted-syntax` or a grep script wired into
   `pnpm lint`) that fails the build on any declaration matching a value-returning secret
   accessor (`get.*[Ss]ecret.*:\s*(Promise<)?string`, `decrypt.*: string` outside
   `crypto.ts`/`broker.ts`). Crude is fine; loud is the point.

5. **System tests** (`tests/system/`, content-named, e.g. `secrets-broker.test.ts`; real
   Chrome + fake-gram):
   - **The value-leak test (non-negotiable):** store a secret, `fill` it into fake-gram's
     login password field, submit → fake-gram's server-side submission record shows the
     correct plaintext; then grep the run's ENTIRE `trace_entries` (payloads and blobs),
     every recorded LLM transcript fixture touched by the test, and all captured log output
     for the plaintext → **zero hits**. This test failing blocks everything.
   - Origin binding: same secret, fill attempted on the fixture site at a different origin
     (second fixture host/port) → refused, `policy_denied` trace entry, `denied_origin` logged.
   - Target validation: hidden input and cross-origin-iframe input → refused with distinct
     outcomes in `secret_access_log`.
   - Rate limit: 4th fill in one run → run fails, outcome `rate_limited`.
   - Crypto round-trip: create → rotate KEK file → old secret still decrypts via stored
     `kek_ref`; `secret_access_log` rows contain action + anchor and no value-length column.

## Style constraints (binding)
- The broker is one module with two public methods; no SecretManager class hierarchy, no
  caching layer (each fill decrypts fresh — the volume is single-digit per run).
- `sodium-native` and nothing else for crypto. New deps: `sodium-native` only.
- The words "password", plaintext values, and `ws_url`s never appear in log lines — bind
  loggers with ids only (§17.2 content rules).

## Verification
```
pnpm install && pnpm build && pnpm test && pnpm lint
```
All prior tests stay green. Run the value-leak test twice; no leaked Chrome processes.

## Report back
What you built, deviations + why, commands + outcomes, flakiness noticed. Do NOT git commit.

> **Built, with deviations.** New package `packages/secrets`: `crypto.ts` (envelope
> encryption), `store.ts` (secret admin: `createSecret`/`grantSecret`), `broker.ts` (the
> broker), `index.ts` (barrel), plus a unit test (`crypto.test.ts`) and a system test
> (`tests/system/secrets-broker.test.ts`). Migration **0011** (`0011_quiet_chat`, generated by
> `drizzle-kit generate` from a schema.ts block kept clearly separated at the file's end, per
> the territory note — S5d takes 0012+ in its own worktree).
>
> **Crypto dep: `sodium-native`, and the AEAD API rather than `crypto_secretbox_*`.** Both this
> doc and `techical_plan.md` §16 name the algorithm as XChaCha20-Poly1305 and point at
> `sodium-native`'s `crypto_secretbox_*` — but libsodium's `crypto_secretbox` construction is
> XSalsa20-Poly1305, not XChaCha20-Poly1305 (same 24-byte nonce, different stream cipher). The
> construction actually named XChaCha20-Poly1305 in libsodium is
> `crypto_aead_xchacha20poly1305_ietf_*`, so `crypto.ts` uses that instead — matching the
> algorithm the design commits to over the parenthetical that misnames it.
> `@types/sodium-native` on npm is pinned to the old v2 API and has no declarations for that
> AEAD family (`sodium-native` here is v5.1.0), so `crypto.ts`'s own
> `packages/secrets/src/sodium-native.d.ts` is a minimal, accurate ambient module scoped to
> exactly the six functions used — the alternative was `as`-casting near key material, which
> the house rules forbid outright. `sodium-native` remains the right (only) dependency: the
> maintained Node binding to libsodium, prebuilt for this platform, and the one new dep class
> the spec allows.
>
> **The no-`get()` control.** `SecretsBroker` (the type every future tool-registry caller sees)
> has exactly `fill`/`injectIntoMcpArg`, both returning success-only shapes
> (`Promise<{ok:true}>` / `Promise<OpaqueHandle>`) — every refusal (origin, target, rate limit,
> tier) throws a typed `AppError` rather than adding an `{ok:false}` branch, so there is no
> return-type shape a value could ever occupy. `redeemMcpHandle` (host-side only, for S5c's MCP
> client, not built here) lives on a *different* type, `SecretsBrokerHandle = SecretsBroker &
> {redeemMcpHandle}`, returned only by `createSecretsBroker` itself — nothing that receives the
> narrower `SecretsBroker` type can reach it. Guarded three ways: (1) this doc comment on
> `broker.ts`, load-bearing per the spec; (2) `packages/secrets/scripts/leak-lint.mjs`, wired
> into `pnpm lint` (`get.*[Ss]ecret.*:\s*(Promise<)?string` and `decrypt.*:\s*(Promise<)?string`
> outside `crypto.ts`/`broker.ts`, scanned across every `.ts` file in the repo — crude regex,
> deliberately); (3) the system test suite exercises `injectIntoMcpArg`→`redeemMcpHandle` and
> asserts the handle itself (`JSON.stringify`'d) never contains the plaintext.
>
> **Driver additions (`packages/browser`), not reuse of `type()`.** The spec asks for a new
> driver-internal `insertTextRaw`, separate from the traced `type()` tool surface, so `driver.ts`
> gained `probeTarget(selector)` and `insertTextRaw(selector, text)` on `Page`, both implemented
> in `playwright-driver.ts` via a shared `resolveAcrossFrames` helper that walks `pwPage.frames()`
> (main frame first) — Playwright's own `page.locator()` never crosses an iframe boundary on its
> own, so this is what makes a same-origin iframe field reachable at all while still naming
> *which* frame matched, which is what target validation's cross-origin check needs.
> `session.ts`'s `makePage` exposes both as **untraced passthroughs** (no `act()` wrapper, no
> policy check, no trace entry) — the broker writes its own `action`/`policy_denied` rows with
> the outcome it decided, never a generic `type` row `text.length` could ride along with.
>
> **`fill`'s order, exactly as specified:** resolve the run → resolve the secret (scoped to the
> run's owning user via `runs→tasks→workflow_versions→workflows.user_id`, since `fill` takes no
> `userId`) → origin binding (`page.url()`'s origin vs `allowed_origins`) → target validation
> (`probeTarget`: `input[type=text|email|password]` only, same-frame-origin only, no
> `contenteditable`, no `hidden`) → rate limit (default 3, in-memory per-run counter) → decrypt
> into a `sodium_malloc` buffer for exactly one `insertTextRaw` call, zeroed in a `finally`.
> Every attempt writes one `secret_access_log` row (`action`/`anchor`/`ts` only — the table has
> no value column to begin with) and, on refusal, one `policy_denied` trace row
> (`check:"secrets.fill"`, `rule:<action>`, never the value).
>
> **Fixture additions** (`apps/testkit/sites/server.ts`, appended after the existing
> login/create-post forms so `tests/system/fixtures/transcripts/*.jsonl`'s hardcoded anchors
> `e5`/`e7` stay valid): a hidden `data-testid="csrfHidden"` field for the target-validation
> test, and a `GET /iframe-wrap?src=` route for the cross-origin-iframe test. `perceive()` never
> surfaces iframe content (same frame-boundary fact as above), so a *real* anchor can never
> point inside one; that test wraps a real session with a `resolveAnchor` override answering one
> synthetic anchor with a raw locator, standing in for what an attacker-crafted locator would
> look like if target validation didn't exist — documented inline as a simulation, not a claim
> that anchors can carry this today.
>
> **Environmental fix, not scope creep:** `packages/db/src/test-db.ts`'s template DB name was a
> fixed string (`tabductor_migrated_template`) shared by every worktree hitting this project's
> one Postgres container (`localhost:5434`). Running alongside the parallel S5d worktree (whose
> migrations don't include this subphase's tables), each side's `prepareTemplate` calls raced —
> `DROP DATABASE`+`CREATE`+replay-own-migrations — so whichever ran last silently overwrote the
> other's schema in the shared template, and the loser's next `INSERT` failed with `relation
> "secrets" does not exist` (confirmed by inspecting the live template's `\dt` mid-collision: it
> had S5d's `assets`/`asset_versions` tables and none of this subphase's). Fixed by suffixing
> the template name with a hash of the migrations directory's own file list, so two worktrees
> with two different (both valid) migration sets get two different template databases instead
> of contesting one. Zero behavior change for a single worktree; every prior test stays green.
>
> **Deviation, scoped deliberately:** no `secrets.fill` tool in `packages/agent/src/tools.ts` —
> the territory note names this as more likely S5c's job (where MCP args are built) and says
> the broker package + its own tests may be all this subphase needs; `packages/agent` is
> untouched. Consequently the spec's "grep every recorded LLM transcript and all captured log
> output" have nothing to search yet in this suite — no LLM call and no logger sit between the
> broker and the page until that wiring exists. What *is* checked, exhaustively: the run's
> entire `trace_entries` (payloads, via `JSON.stringify`) and its entire `secret_access_log`,
> for every test in the suite, not just the headline one.
>
> `secret_grants` (declared, per spec, not enforced) and Tier 2 (`user_wrapped`, refused with a
> typed error and a `denied_tier` log row) are both present as designed placeholders, matching
> "the table exists now" / "Phase 7" from the spec and `techical_plan.md` §16.
>
> Tests: `packages/secrets/src/crypto.test.ts` (5, pure — no DB, no Chrome) +
> `tests/system/secrets-broker.test.ts` (7: value-leak, origin binding, hidden field,
> cross-origin iframe, rate limit, `injectIntoMcpArg`/`redeemMcpHandle` round trip, KEK
> rotation). Full suite: **187 tests across 46 files (1 skipped), green twice** — once under
> the default pool, once (after one `net::ERR_ABORTED` under full Chrome concurrency, the
> documented environmental flakiness) under `--pool=forks --poolOptions.forks.maxForks=4`, at
> which point the same run was green outright too. No leaked Chrome processes or test databases
> after either run (checked via `pgrep`/`pg_database`).
