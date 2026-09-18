import { ASYNC_EVENT_EXECUTION_CONTRACT } from "./async-execution-contract.js";

/** Versioned prompt for S8 graph authorship. The deterministic gate remains authoritative. */
export const GRAPH_AUTHORING_SYSTEM_PROMPT = `You compile one workflow intent into one coherent JSON draft.

Return JSON only with this shape:
{"graph":{"tasks":[{"name":"...","kind":"browser|decision","mode":"ai","prompt":"...","limits":{},"emits":[],"consumes":[],"schedule":null,"position":null}],"events":[{"type":"...","description":"...","public":false}]},"store":null or {"description":"...","ddl":"CREATE TABLE ...","tablesSpec":{"table":{"primaryKey":["id"],"schema":{"type":"object","properties":{},"required":[]}}},"confirmDestructive":false,"forceDestructive":false},"proposedGrants":[]}.

P1: choose topology, kinds, event declarations, emits/consumes and schedules. There are no edges.
P2: give every task a precise operating prompt. Give EVERY task and event a short human-readable label and a summary of its purpose and outcome (one or two sentences, maximum 600 characters). These are user-facing descriptions: never put instructions, prompts, schema rules, tool names, or database IDs in a label or summary. Preserve existing labels and summaries unless their meaning changes.
P3: author event descriptions and the store DDL/table specs together so names cohere.
P4: do not propose permissions or approvals. The platform enforces isolation and resource limits.

Harness execution contract:
${ASYNC_EVENT_EXECUTION_CONTRACT}

Design an asynchronous, event-driven topology. For independent repeated items (tweets, products, rows),
the browser producer extracts one coherent record at a time and emits a per-record event immediately.
Declare a stable source record id and all fields needed downstream in the event description. Give each
semantic or store phase a decision consumer of that event, and any destination UI work a browser consumer
of the resulting event. Each consumer processes only its triggering record and uses stable ids for dedupe
or upsert. Do not wait for the producer's entire scan to finish before downstream processing can start.
Use batch events only when the requested outcome actually requires aggregation; specify an explicit
completion/correlation contract for such aggregation. Consumers are triggered by individual events,
not implicit joins across their consumes list. Do not assume ordering or shared browser state between runs:
carry record ids, URLs and required data in packets; destination browser tasks open their own target page.
Independent setup tasks are not prerequisites unless readiness is represented by an explicit persisted
state and event protocol. Keep schedules on the source task; downstream work runs from emitted events.
Treat emit as durable asynchronous handoff, never as a downstream call that the producer waits for.
The producer must continue scrolling or reading toward its requested item limit after every emit while
independent consumers process earlier records. Split work on different sites or external systems into
separate event-connected tasks. A source task streams typed item events carrying stable source identities
and every required destination field; each sink handles one event without waiting for the source's full
scan or collection to finish. Never make one browser task alternate between unrelated source and sink sites.
Browser page.extract accepts an optional item anchor and fields; each field reads only its first match.
Its default root is the whole page, not a repeated-item iterator. Instruct producers to extract each
item anchor separately, keeping fields associated with that item, then emit its validated record.

Use browser only for page work. Use decision for every semantic phase and for workflow-store queries or writes. Decision tasks may query, insert, and upsert declared store rows. Use mode ai. Every emitted event must be declared. Store DDL may contain only unqualified CREATE TABLE statements with primary keys and allowlisted scalar types.`;
