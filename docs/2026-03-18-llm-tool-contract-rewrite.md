# LLM Tool Contract Rewrite

Date: 2026-03-18

## Context

The previous Tabductor contract had the right primitives, but it still made common LLM failure modes too easy:

- large pages could overflow tool outputs because `tabductor_actionables` returned the entire grouped inventory
- action calls required both `ref` and `element`, even though `ref` was the real handle
- navigation responses did not clearly tell the model whether navigation had actually been observed
- post-action discovery bundles existed, but the payload shape did not emphasize “use these next refs now”

This rewrite intentionally prioritizes ease of calling for LLM agents over backward compatibility.

## Decisions

### 2026-03-18

- Rewrote `tabductor_actionables` as a bounded, filterable discovery tool.
- Added query, exact matching, role filters, viewport filtering, group filtering, and explicit limits.
- Rationale: large real-world pages should not force models into full-inventory reads.

### 2026-03-18

- Repositioned `tabductor_find_text` as an actionable finder instead of a raw snapshot text search.
- It now returns ranked actionable matches plus a `recommendedRef`.
- Rationale: “find the thing matching this text and click it” is a primary LLM workflow and should be one call.

### 2026-03-18

- Made `element` optional on action tools and kept `ref` as the primary action handle.
- Rationale: requiring both fields created avoidable schema failures and duplicated data the MCP can already infer.

### 2026-03-18

- Changed action follow-up payloads from generic discovery attachment to explicit `nextDiscovery` and `nextRefs`.
- Kept the same proactive refresh idea, but made the naming sharper for next-step planning.
- Rationale: the model should not have to infer that the attached bundle is meant for the immediate next action.

### 2026-03-18

- Added explicit navigation wait behavior to `tabductor_navigate` with `waitUntil` and `timeoutMs`.
- Added result fields such as `navigationObserved`, `currentUrl`, `currentTitle`, and `transportConnected`.
- Rationale: LLMs need a direct signal for whether navigation was observed, especially across reconnects and delayed page updates.

## Discarded Behavior

- Full unbounded actionable inventories as the default discovery response.
- Treating `tabductor_find_text` as a broad low-level DOM text search.
- Requiring `element` for click, hover, type, and select actions.
- Generic post-action discovery naming that did not clearly indicate “these are the next refs”.

## Resulting Workflow

1. Use `tabductor_session_overview` to orient.
2. Use `tabductor_actionables` with filters, or `tabductor_find_text` when you know the target text.
3. Use action tools with `ref` and optional `pageVersion`.
4. Prefer the action response’s `nextDiscovery` and `nextRefs` before making another read call.
5. Use `tabductor_snapshot` only when the compact discovery tools are insufficient.
