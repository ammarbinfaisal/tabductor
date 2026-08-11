import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Data model per techical_plan §14, trimmed to what S1–S2 need. All tables the engine
 * will use are declared now so later phases only add columns, never renumber migrations.
 * Prefixed string ids come from core `newId`; `events.event_id` is a raw uuid because it
 * is the dedupe primary key and is joined by uuid in the lineage CTE.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();

/**
 * Closed column domains.
 *
 * These are `text` columns, deliberately — §4 wants a new run status or schedule policy to
 * be a code change rather than a migration — so the domain is declared here beside the
 * column and applied with `$type`. It is an assertion about what the writers write, not a
 * constraint the database enforces, and it holds because each of these columns has exactly
 * one writing module (`run-state.ts`, `publishVersion`).
 *
 * They live in the schema package because everything else derives from them: the engine
 * re-exports `RunStatus`, and the graph document builds its zod enums from these tuples
 * instead of restating the members. One list per domain, whatever asks the question.
 */
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const MISSED_POLICIES = ["skip", "fire_once_catchup"] as const;
export type MissedPolicy = (typeof MISSED_POLICIES)[number];

export const OVERLAP_POLICIES = ["skip", "queue"] as const;
export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number];

export const workflows = pgTable("workflows", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  currentVersionId: text("current_version_id"),
  maxHops: integer("max_hops").notNull().default(20),
  createdAt: createdAt(),
});

export const workflowVersions = pgTable("workflow_versions", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  graphJson: jsonb("graph_json").notNull().default({}),
  createdAt: createdAt(),
});

/**
 * `name` is the task's identity *across* workflow versions: every version gets fresh task
 * rows, so routing an event emitted under v1 against the latest version (§5 versioning)
 * needs a stable key, and the graph editor's node name is it.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt"),
    mode: text("mode").notNull().default("stub"),
    limitsJson: jsonb("limits_json").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tasks_version_name_key").on(t.workflowVersionId, t.name)],
);

/**
 * The event as an entity of the graph, not a property of its emitter: one row per
 * (version, type), whoever emits it. The wiring model routes on event types, so this is
 * where everything about a type lives — the author's plain-language `description` (the
 * only thing the client sends), the `packet_schema_json` the publish-time compiler
 * generated from it, and the S2d share visibility.
 *
 * Emission and consumption are declared by tasks in `task_emits` / `task_consumes`;
 * there is no edges table — topology is derived by matching types.
 */
export const eventDefs = pgTable(
  "event_defs",
  {
    id: text("id").primaryKey(),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    /** The author's prompt — what the packet *means*. The schema below is compiled from it. */
    description: text("description").notNull().default(""),
    packetSchemaJson: jsonb("packet_schema_json").notNull().default({}),
    /**
     * sha256 over (description + sorted emitter prompts + sorted consumer prompts) at the
     * time the schema was compiled. Publish compares the incoming document's hash against
     * this and carries the schema forward untouched on a match — the stability guarantee
     * that makes republishing an unchanged event free of LLM calls. Empty means "never
     * compiled" (backfilled rows), which forces generation on the next publish.
     */
    promptHash: text("prompt_hash").notNull().default(""),
    /**
     * Share visibility (S2d, sharing.md §3.2): may a share viewer read packets of this
     * event type? Projected from the graph document, so it versions with the graph.
     *
     * The default is the safety property, not a convenience: an event added in a later
     * version arrives private because of this line, and there is no state from the
     * previous version that could carry a stale `true` forward.
     */
    public: boolean("public").notNull().default(false),
  },
  (t) => [uniqueIndex("event_defs_version_type_key").on(t.workflowVersionId, t.eventType)],
);

/**
 * A task's declaration that it emits packets of a type. The type's schema lives on
 * `event_defs`. `workflow_version_id` is denormalized from the task so per-version reads
 * (the graph document, the public manifest) need no join.
 */
export const taskEmits = pgTable(
  "task_emits",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.eventType] })],
);

/**
 * A task's subscription: an event of this type triggers it. This is the routing table —
 * dispatch resolves subscribers as one probe of `(version, type)`, the exact successor of
 * the dropped `edges_routing_idx`, which is why the version id is denormalized here.
 */
export const taskConsumes = pgTable(
  "task_consumes",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.eventType] }),
    index("task_consumes_routing_idx").on(t.workflowVersionId, t.eventType),
  ],
);

/**
 * A share: an unguessable link granting read-only access to one workflow's execution
 * (sharing.md §2). The token is a bearer credential of the same class as a CDP `wss://`
 * URL (§16 Threat 5), so only its hash is stored — a dump of this table yields no working
 * links. `token_prefix` exists so the owner can tell their shares apart without our
 * holding anything that opens one.
 *
 * There is deliberately no access-log table: a view is not product data, and a row per
 * public page load would make Threat 16 cheaper. Views are a metric.
 */
export const workflowShares = pgTable(
  "workflow_shares",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    tokenSha256: text("token_sha256").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    createdAt: createdAt(),
    /** Revocation is a timestamp, not a delete, so a revoked link stays auditable. */
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    // Unique because it is also the lookup: every public request resolves a token through
    // this index, and resolution is uncached so revocation takes effect immediately.
    uniqueIndex("workflow_shares_token_key").on(t.tokenSha256),
    index("workflow_shares_workflow_idx").on(t.workflowId),
  ],
);

export const events = pgTable(
  "events",
  {
    eventId: uuid("event_id").primaryKey(),
    type: text("type").notNull(),
    sourceTaskId: text("source_task_id"),
    sourceRunId: text("source_run_id"),
    causationId: uuid("causation_id"),
    packet: jsonb("packet").notNull().default({}),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    /** W3C trace context of the span that published this (§17.2 rule 3). Null when telemetry
     * was disabled, which is the normal case — a null reads as "start a root span". */
    traceparent: text("traceparent"),
  },
  (t) => [index("events_causation_idx").on(t.causationId)],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    triggerEventId: uuid("trigger_event_id"),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    /** Open by design: `stub` today, `ai`/`compiled`/`python` later. Not a closed domain. */
    modeUsed: text("mode_used").notNull(),
    attempt: integer("attempt").notNull().default(0),
    /** Retry backoff gate (§15): a `queued` run is invisible to the engine's pickup poll
     * until now() passes this. Null means "runnable immediately". */
    notBefore: ts("not_before"),
    heartbeatAt: ts("heartbeat_at"),
    startedAt: ts("started_at"),
    /** Wall-clock kill time, set on `running` from `limits_json.run_timeout_ms`. The
     * watchdog scans this column, so a timeout survives an engine restart (§15). */
    deadlineAt: ts("deadline_at"),
    endedAt: ts("ended_at"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("runs_status_heartbeat_idx").on(t.status, t.heartbeatAt),
    index("runs_deadline_idx").on(t.status, t.deadlineAt),
    index("runs_queued_idx").on(t.status, t.notBefore),
  ],
);

/** Consumer-side dedupe (§6): one row per (task, event); the unique pk is the claim. */
export const runDedupe = pgTable(
  "run_dedupe",
  {
    taskId: text("task_id").notNull(),
    eventId: uuid("event_id").notNull(),
    claimedAt: ts("claimed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.eventId] })],
);

/** Transactional outbox: written in the same trx as the domain write, drained by the dispatcher. */
export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.eventId, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    dispatchedAt: ts("dispatched_at"),
    createdAt: createdAt(),
    /** Copied from the event so the dispatcher can parent its consumer span without a join
     * on the hot path (§17.2 rule 3). */
    traceparent: text("traceparent"),
  },
  (t) => [
    index("outbox_pending_idx")
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Cron schedules (§7). The row is the source of truth — the scheduler holds no state a
 * restart could lose, and `last_fired_at` is what the missed-fire policy reads on boot.
 */
export const schedules = pgTable("schedules", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  cron: text("cron").notNull(),
  tz: text("tz").notNull().default("UTC"),
  missedPolicy: text("missed_policy").$type<MissedPolicy>().notNull().default("skip"),
  overlapPolicy: text("overlap_policy").$type<OverlapPolicy>().notNull().default("skip"),
  /** How many fires may wait behind the live run under `queue` (§7); user-configurable. */
  maxQueueDepth: integer("max_queue_depth").notNull().default(1),
  lastFiredAt: ts("last_fired_at"),
  enabled: boolean("enabled").notNull().default(true),
});

/**
 * The trace: the ordered log of one run (§14). Traces are the assertion surface for the
 * system tests and the compiler's input in Phase 6, so the columns are deliberately dumb —
 * a kind, a JSON payload, and an optional pointer to a blob that was too big to inline.
 *
 * `seq` is assigned by the writer (`createTraceRecorder`), monotonic within a run, and the
 * second half of the primary key: ordering is a property of the row, not of `created_at`,
 * because a buffered flush writes several entries inside one millisecond.
 *
 * Storage of each category is opt-out per task (§14) and evaluated at *write* time — a
 * category the user turned off is never written, rather than written and later deleted.
 */
export const TRACE_KINDS = [
  "navigation",
  "action",
  "network",
  "policy_denied",
  "llm",
] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

export const traceEntries = pgTable(
  "trace_entries",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").$type<TraceKind>().notNull(),
    payloadJson: jsonb("payload_json").notNull().default({}),
    /** Set when the entry's payload was offloaded to the blob store (screenshots, bodies). */
    blobRef: text("blob_ref"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

/**
 * A blob a run produced, addressed by `blob_ref` in the blob store. Separate from
 * `trace_entries` because artifacts outlive the entry that referenced them and are listed
 * on their own (the run inspector's screenshot strip, U1.5).
 */
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    blobRef: text("blob_ref").notNull(),
    meta: jsonb("meta").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("artifacts_run_idx").on(t.runId)],
);

/**
 * A user's CDP endpoint (§8, §14): one physical browser connection, pooled and
 * health-checked by S3b's endpoint pool (`packages/browser/src/pool.ts`).
 *
 * -- TODO S7: encrypt `ws_url`. It is a bearer credential (§16 Threat 5) — plaintext is
 * acceptable this phase only because the product is single-user local; nothing here is a
 * security decision that survives multi-tenant.
 */
export const cdpEndpoints = pgTable("cdp_endpoints", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  wsUrl: text("ws_url").notNull(),
  label: text("label"),
  healthy: boolean("healthy").notNull().default(true),
  lastCheckedAt: ts("last_checked_at"),
  /** Waiters beyond this many queued runs fail `endpoint_queue_full` (§15 backpressure). */
  maxQueueDepth: integer("max_queue_depth").notNull().default(10),
  createdAt: createdAt(),
});

/**
 * Per-endpoint serialization (§8): one row means one run holds the endpoint. A DB row
 * rather than an in-memory lock so the claim survives an engine restart — the next process
 * to boot sees the same row and the same heartbeat. `endpoint_id` alone is the primary key,
 * which is the serialization itself: a second run cannot insert its own row while this one
 * exists, only steal it once `heartbeat_at` goes stale (the pool's atomic claim query).
 */
export const endpointLeases = pgTable("endpoint_leases", {
  endpointId: text("endpoint_id")
    .primaryKey()
    .references(() => cdpEndpoints.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull(),
  heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
});

/** `ctx.state` (§12) — per-task key/value, used by emitIfNew and compiled scripts. */
export const taskState = pgTable(
  "task_state",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.key] })],
);

export type TraceEntryRow = typeof traceEntries.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type OutboxRow = typeof outbox.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type EventDefRow = typeof eventDefs.$inferSelect;
export type TaskEmitRow = typeof taskEmits.$inferSelect;
export type TaskConsumeRow = typeof taskConsumes.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type WorkflowShareRow = typeof workflowShares.$inferSelect;
export type CdpEndpointRow = typeof cdpEndpoints.$inferSelect;
export type NewCdpEndpoint = typeof cdpEndpoints.$inferInsert;
export type EndpointLeaseRow = typeof endpointLeases.$inferSelect;
