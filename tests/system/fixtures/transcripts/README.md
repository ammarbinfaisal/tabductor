# Recorded agent transcripts

These JSONL files make browser-agent system tests deterministic. Each record contains one
model request and response. The replay adapter checks that the requested tool set matches the
recorded tool set, so any browser capability change requires updating the fixtures.

Decision tests generally use small in-process model scripts because their store results are
created dynamically. There are no asset, external-MCP, renderer, or Python transcripts.

Browser fixtures use `__ELEMENT__:{...}` to describe an observed element by name/tag or href
suffix. The test harness binds that description to the latest snapshot anchor; production
never accepts these placeholders. Completion turns include an observable `page.verify`
before `done`. Native tool result messages preserve the original two-messages-per-turn shape.
