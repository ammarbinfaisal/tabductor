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
