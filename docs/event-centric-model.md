# Event-centric workflow model

A workflow version is an internal graph of browser and decision tasks connected by typed event
names. Authors describe behavior; the compiler chooses tasks and event topology.

Each event declaration has a type, a natural-language packet description, a compiled JSON
Schema, and a private-by-default sharing flag. Tasks list the types they consume and emit;
matching lists derive edges. System/manual events may be consumed without an in-graph producer.

Publication is append-only. Runs are pinned to the version they started under, while new events
route against the workflow's current version. Store data deliberately persists across versions,
with its schema migrated as part of publication.

Schedules and manual triggers are event sources. At the public MCP boundary they address a
workflow; the control plane resolves the graph's root behaviors and keeps task ids private.
