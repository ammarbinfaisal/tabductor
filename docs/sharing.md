# Sharing

A share is an unguessable, revocable, read-only view of a workflow's behavior, triggers, run
status/timings, event lineage, and explicitly public packet bodies. Internal graph topology,
task ids, prompts, limits, grants, store schema/data, browser endpoints, secrets, and raw run
errors are never public.

Event visibility is private by default and versioned with the graph. SQL queries apply the
share's workflow id and public event-type manifest before packets leave the database. Workflow
and task identities are represented by share-scoped opaque references.

Public pages render packet strings as text, apply a restrictive CSP, never expose mutation
procedures, and answer unknown, malformed, and revoked tokens identically. There is no public
file/blob route: the product no longer has workflow assets.
