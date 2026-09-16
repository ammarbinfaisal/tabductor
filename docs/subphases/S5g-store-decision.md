# S5 — Decision store

Implemented. Each workflow owns a versioned store schema and isolated Postgres schema. Decision
tasks receive `store.query`, `store.insert`, and `store.upsert`; browser tasks receive none.

DDL and table JSON Schemas are compiled with the graph. Publication validates their bijection,
classifies migrations, applies additive changes, and requires confirmation for destructive
changes. Writes validate rows, obey optional table grants, stage during the agent turn, and
commit atomically with the next event or successful completion.

The old three-kind “decision reads, asset writes” split is retired. Decision owns both semantic
reads and writes.
