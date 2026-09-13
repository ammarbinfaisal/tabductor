# S7 — Policy, permissions and approvals

**Status:** done. Migration `0021_wet_peter_quill.sql`.

The engine composition root now uses `DatabasePolicyGate`. `AllowAllGate` remains a
test/permissive-profile implementation, not the production default.

## Decision order

For each intercepted operation:

1. resolve the task's owning user;
2. validate and apply account baseline rules;
3. let a matching baseline deny win permanently;
4. resolve the task-version grant;
5. deny sensitive capabilities with no grant;
6. park if the grant or baseline requires approval;
7. otherwise allow.

Basic page actions and network bodies remain default-allow during migration. Navigation,
network headers, MCP calls, secrets, uploads/downloads and asset writes are default-deny.
Malformed baseline rows fail closed.

Grant families are `navigation`, `action`, `network.headers`, `network.body`,
`mcp.call`, `secret.use`, `secrets.read`, and `asset.write`. MCP and action values
accept globs; navigation values match a host and its subdomains. `secret.use` and
`asset.write` also populate the dedicated `secret_grants` and `asset_write_grants`
tables, so those older and narrower enforcement points remain authoritative.

## Enforcement

- Browser actions and every navigation, including redirects and popups, cross the database
  gate in production.
- Network headers require a grant. Authorization, Cookie, Set-Cookie and token-shaped values
  stay masked unless the separate `secrets.read` grant exists.
- Asset executors filter discovered MCP tools before building the model-visible registry and
  check the same grant again at call time.
- Asset writes keep their path-glob check and additionally cross the policy gate.
- Secret fills and MCP credential injection enforce `secret_grants` through the gate.
  `secrets.fill` delegates directly to the host broker; plaintext never becomes a tool result.
- Every actual refusal emits `policy.denied` and the existing enforcement point records its
  local trace verdict.

## Approvals

A `requires_approval` decision atomically changes the live run from `running` to
`awaiting_approval`, inserts an `approvals` row and emits `approval.requested`. The gate
waits at the intercepted call, leaving the page untouched. A control-plane decision emits
`approval.granted` or `approval.denied`; a grant restores `running` and performs the
action. Denial or expiry restores `running` only so the executor can settle the failure.
Cancellation also cancels the pending approval.

An engine restart cannot restore the in-memory CDP session behind a parked row. Startup marks
such runs failed with `engine_restart_while_awaiting_approval` and applies the normal retry
policy rather than pretending to resume a lost page.

The UI exposes per-node grants, the account baseline and a polling approvals inbox.

## Deliberate cut

Tier-2 user-wrapped secrets remain deferred, using the explicit cut allowed by Phase 7. The
server has no client-held Argon2id key/session protocol yet; labelling the existing encrypted
server secret as user-wrapped would be a false security claim. The approval machinery needed
for a future attended unlock is now present.

## Verification

`policy-evaluator.test.ts` covers the decision matrix, non-overridable baseline, MCP
visibility, dedicated secret/asset grants, redaction, approval resume, expiry and malformed
baseline state. `AllowAllGate` remains the permissive regression profile.
