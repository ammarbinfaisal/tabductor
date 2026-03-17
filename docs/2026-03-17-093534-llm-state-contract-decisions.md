# LLM State Contract Decisions

Date: 2026-03-17
Time: 09:35:34 IST

## Context

Goal: reduce stale-ref friction and make the MCP layer easier for LLM agents to use without needing immediate follow-up reads after every state-changing action.

## Decisions

### 2026-03-17 09:35:34 IST

- Renamed the LLM-facing version field from `snapshotVersion` to `pageVersion`.
- Kept `snapshotVersion` only in the extension-side transport where it still describes snapshot internals.
- Rationale: agents reason about whether the page changed, not about transport snapshots.

### 2026-03-17 09:35:34 IST

- Standardized reads around a single discovery bundle shape: page metadata, `pageVersion`, grouped actionables, context anchors, and summary stats.
- Reused that same bundle for `browser_session_overview`, `browser_actionables`, and action follow-up responses.
- Rationale: one state shape is easier for agents to learn than separate read-specific response formats.

### 2026-03-17 09:35:34 IST

- Changed write-tool behavior so that when `pageVersion` advances, the tool response proactively includes fresh discovery state for the next step.
- Rationale: the best retry is the one the model never has to discover with another MCP round trip.

### 2026-03-17 09:35:34 IST

- Kept stale-ref as an explicit error, but changed the error payload to include fresh discovery state inline.
- Rationale: this preserves correctness when a ref is invalid while removing the extra “go fetch actionables again” loop.

### 2026-03-17 09:35:34 IST

- Continued to keep same-session operations serialized.
- Rationale: reducing LLM friction should not introduce DOM race conditions or ambiguous write ordering.

## Rejected Alternatives

- Always return a full fresh snapshot after every action.
  Reason: simpler, but too expensive in tokens and unnecessary when the page version does not advance.

- Hide versioning entirely from the LLM.
  Reason: agents still need a clear signal for whether their refs belong to the current page state.

- Auto-retry stale refs inside the MCP layer without surfacing a stale result.
  Reason: a stale ref usually means the model must choose a new ref intentionally; silent retries risk acting on the wrong element.
