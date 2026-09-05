import {
  bigserial,
  boolean,
  check,
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

/**
 * `tasks.kind` (§4, S5a): what a task may *do* — the tool registry and executor
 * discriminant, orthogonal to `mode` (*how* it executes). Declared here, not in
 * `packages/engine`, so the graph document's zod enum and the `tasks_kind_check` constraint
 * below read from the same list instead of restating it on each side of the publish boundary.
 *
 * `decision` (S5g, graph-compilation-llm §2.1): the planner kind — `store.query` + `emit`
 * only, the smallest registry in the system. Unlike `asset`, a schedule *may* bind to it
 * (§2.1's kind table) — see `SCHEDULABLE` in `packages/engine/src/graph.ts`.
 */
export const TASK_KINDS = ["browser", "asset", "decision"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

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
    /** What the task may do (§4) — see `TASK_KINDS`. Backfilled `browser` on existing rows:
     * every task before S5a drove a page, so that is the only honest default. */
    kind: text("kind").$type<TaskKind>().notNull().default("browser"),
    /**
     * *How* the task executes. Authored as `stub` (graph testing) or `ai`; `compiled` is
     * **engine-assigned** — S6c's promotion writes it after a clean `ai` run compiled, and
     * demotion writes `ai` back. `publishVersion` carries a still-valid `compiled` forward by
     * `content_hash`; the editor never offers it and `checkGraph` rejects it in a document.
     */
    mode: text("mode").notNull().default("stub"),
    limitsJson: jsonb("limits_json").notNull().default({}),
    // -- Publish-time prompt compilation --------------------------------------------------
    /**
     * The detailed operating instructions the AI actually runs under, compiled at publish
     * from the *whole* graph context (`prompt-compiler.ts`): the author's `prompt`, the
     * events this task consumes and emits with their compiled schemas, its neighbours, its
     * kind's tool surface and the workflow store's tables. `prompt` stays what the author
     * sees and edits; this is what the executors read. Never written by `updateTask`.
     */
    compiledPrompt: text("compiled_prompt"),
    /** Carry-forward key for `compiled_prompt` (the `prompt_hash` precedent on `event_defs`). */
    compiledPromptHash: text("compiled_prompt_hash"),
    /**
     * sha256 over everything a compiled *script* depends on (graph-compilation-llm §6.3):
     * kind, the compiled prompt, and the consumed/emitted event schemas. Equal across two
     * versions means the previous version's active script is still the right script, so
     * `publishVersion` carries it (and mode `compiled`) onto the new task row instead of
     * sending the task back through AI runs it has already paid for.
     */
    contentHash: text("content_hash"),
    // -------------------------------------------------------------------------------------
    // -- S6c: promotion / demotion counters (§11's binding numbers: K=2, 3-in-10) ----------
    /** Consecutive `ai` runs that succeeded *and* agreed with their predecessor. Reset by any
     * failure or divergence — "two clean consistent runs" has to mean consecutive, or a task
     * that works one run in three would eventually promote on the strength of runs weeks
     * apart. */
    cleanAiRuns: integer("clean_ai_runs").notNull().default(0),
    /** The last <=10 compiled runs as booleans, newest last: `true` = that run deopted. A
     * column rather than a table (S6c style rule), and a *window* rather than a count because
     * §11's rule is "3 within the last 10", which a bare counter cannot answer. */
    recentDeopts: jsonb("recent_deopts").notNull().default([]),
    // -------------------------------------------------------------------------------------
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("tasks_version_name_key").on(t.workflowVersionId, t.name),
    check("tasks_kind_check", sql`${t.kind} in ('browser','asset','decision')`),
    // §11: asset tasks are never compiled — MCP results and LLM prose have no stable
    // structure for the script compiler's guards to assert on. One exclusion; `mode` stays an
    // open domain (a bare `z.string()` in `graphTaskSchema`) so a test-only executor can claim
    // a value without a schema change — `scripted-browser.test.ts` publishes `mode='scripted'`
    // through the real publish path. The former `python` clause went with the mode: Python is
    // the asset node's `python.run` tool now, not a way a task executes.
    check("tasks_kind_mode_check", sql`not (${t.kind} = 'asset' and ${t.mode} = 'compiled')`),
  ],
);

/**
 * S6a — one row per compiled script version for a task (§14). `guards_meta` is what the
 * compiler recorded about the guards it generated; `from_runs` is the run ids the script was
 * compiled from, so a script can always be traced back to the traces that produced it.
 *
 * The partial unique index is the load-bearing part: it makes "the active script for a task"
 * a fact the **database** enforces, rather than an invariant S6c's activation swap has to get
 * right under concurrent writes. That swap becomes one transaction — old row to `invalidated`,
 * new row to `active` — which this index makes safe rather than merely usually-correct.
 */
export const COMPILED_SCRIPT_STATUSES = ["candidate", "active", "invalidated"] as const;
export type CompiledScriptStatus = (typeof COMPILED_SCRIPT_STATUSES)[number];

export const compiledScripts = pgTable(
  "compiled_scripts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** Prior max + 1 for the task, starting at 1. */
    version: integer("version").notNull(),
    source: text("source").notNull(),
    guardsMeta: jsonb("guards_meta").notNull().default({}),
    /** Run ids this script was compiled from (S6b's `from_runs` provenance). */
    fromRuns: jsonb("from_runs").notNull().default([]),
    status: text("status").$type<CompiledScriptStatus>().notNull().default("candidate"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("compiled_scripts_task_version_key").on(t.taskId, t.version),
    // At most one active script per task, enforced where it cannot be raced.
    uniqueIndex("compiled_scripts_active_task_key")
      .on(t.taskId)
      .where(sql`${t.status} = 'active'`),
    check("compiled_scripts_status_check", sql`${t.status} in ('candidate','active','invalidated')`),
  ],
);

export type CompiledScriptRow = typeof compiledScripts.$inferSelect;

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
export const cdpEndpoints = pgTable(
  "cdp_endpoints",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    /**
     * The workflow this endpoint belongs to (U3a). A workflow's browser runs rotate over its
     * own endpoints — `pickWorkflowEndpoint` in `packages/engine/src/queries.ts` — so an
     * endpoint is *owned*, never shared across workflows. Nullable only for rows created by
     * test rigs that hand an executor a fixed id; the control plane always sets it.
     */
    workflowId: text("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
    wsUrl: text("ws_url").notNull(),
    label: text("label"),
    healthy: boolean("healthy").notNull().default(true),
    lastCheckedAt: ts("last_checked_at"),
    /** Waiters beyond this many queued runs fail `endpoint_queue_full` (§15 backpressure). */
    maxQueueDepth: integer("max_queue_depth").notNull().default(10),
    /** Order within the workflow's list; the rotation's tie-breaker. */
    position: integer("position").notNull().default(0),
    /** Stamped by `pickWorkflowEndpoint` — least-recently-acquired goes first. */
    lastAcquiredAt: ts("last_acquired_at"),
    createdAt: createdAt(),
  },
  (t) => [index("cdp_endpoints_workflow_position_idx").on(t.workflowId, t.position)],
);

/**
 * What the engine process registered at boot (U3a). The control plane and the engine share
 * only Postgres, so this row is how the editor learns which `(kind, mode)` pairs a run can
 * actually be dispatched to — instead of guessing from its own environment, which would
 * lie whenever the two processes are configured differently. Single row (`id = 'engine'`);
 * `heartbeat_at` is bumped on the engine's watchdog tick so a dead engine reads as stale.
 */
export const engineStatus = pgTable("engine_status", {
  id: text("id").primaryKey(),
  /** `executorKey(kind, mode)` strings, e.g. `"browser:ai"`. */
  executors: jsonb("executors").$type<string[]>().notNull().default([]),
  /** Tool-level abilities that are not a `(kind, mode)` pair — `"python.run"` when the
   * engine has a `PYRUNNER_URL`. The editor reads this to say what an asset node can do. */
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  bootedAt: ts("booted_at").notNull().defaultNow(),
  heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
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

// ---------------------------------------------------------------------------------------
// S5b — secrets broker (§14, §16 Threat 4). A clearly separated block: S5b and S5d land in
// parallel worktrees and both touch this file, so everything the secrets broker owns lives
// here, after S3b's endpoint tables, rather than interleaved with them.
// ---------------------------------------------------------------------------------------

/** Tier 1 is server-decryptable (this subphase); Tier 2 additionally wraps the DEK with a
 * user-held key and is Phase 7 — the column exists now so no later migration has to widen it. */
export const SECRET_TIERS = ["server", "user_wrapped"] as const;
export type SecretTier = (typeof SECRET_TIERS)[number];

/**
 * Envelope-encrypted secret (§16 Threat 4): `ciphertext`/`nonce` are the value sealed under a
 * per-secret DEK (`packages/secrets/src/crypto.ts`); `dek_wrapped`/`kek_ref` are that DEK
 * wrapped by a KEK a `KeyWrapper` resolves by `kek_ref` — never a plaintext DEK or value at
 * rest. `allowed_origins` is the origin-binding control (§16): a property of the secret
 * itself, checked at fill time against the page's live origin, not a task grant — which is
 * why it lives here and not on `secret_grants`.
 */
export const secrets = pgTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    tier: text("tier").$type<SecretTier>().notNull().default("server"),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    dekWrapped: text("dek_wrapped").notNull(),
    kekRef: text("kek_ref").notNull(),
    allowedOrigins: jsonb("allowed_origins").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    rotatedAt: ts("rotated_at"),
  },
  (t) => [
    uniqueIndex("secrets_user_name_key").on(t.userId, t.name),
    check("secrets_tier_check", sql`${t.tier} in ('server','user_wrapped')`),
  ],
);

/**
 * Which task may use which secret. Declared now, per techical_plan §14; *enforcement* is
 * Phase 7 (S7's grant/redaction sweep) — the broker in this subphase checks origin binding,
 * target validity and the per-run rate limit only, not this table.
 */
export const secretGrants = pgTable(
  "secret_grants",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    secretName: text("secret_name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.secretName] })],
);

/**
 * Every fill attempt, success or refusal (§16 Threat 4) — action, anchor and outcome only.
 * There is deliberately no value or value-length column: unlike `secret_grants`, which is a
 * table this subphase declares without enforcing, this table is written on every `fill` call
 * starting now, so "nothing to accidentally write a value into" has to be true from the
 * first row, not from Phase 7.
 */
export const SECRET_ACCESS_ACTIONS = [
  "filled",
  "injected",
  "denied_origin",
  "denied_tier",
  "denied_target_not_found",
  "denied_target_hidden",
  "denied_target_type",
  "denied_target_contenteditable",
  "denied_target_cross_origin_frame",
  "insert_failed",
  "rate_limited",
] as const;
export type SecretAccessAction = (typeof SECRET_ACCESS_ACTIONS)[number];

export const secretAccessLog = pgTable(
  "secret_access_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    secretName: text("secret_name").notNull(),
    action: text("action").$type<SecretAccessAction>().notNull(),
    anchor: text("anchor"),
    ts: ts("ts").notNull().defaultNow(),
  },
  (t) => [index("secret_access_log_run_idx").on(t.runId)],
);

// -- S5d: asset store (techical_plan §13.5, §14) --------------------------------------
//
// User deliverables, not trace exhaust: no TTL, and nothing here cascades away when a run
// or a task is deleted. Reads are open across a user's workflows (`assets` carries no
// workflow id at all, only `user_id`); writes are scoped by `asset_write_grants`, checked
// in `packages/assets`, not by anything the database enforces — the grant table is data the
// tool layer consults, the same posture `AllowAllGate` uses everywhere else pre-Phase-7.

/**
 * One row per `(user_id, path)` — the current pointer. `blob_ref`/`sha256`/`size` mirror the
 * *current* version's row in `asset_versions` so a reader wanting only the latest content
 * never joins; `current_version` is the version counter, bumped by every write.
 */
export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    path: text("path").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    blobRef: text("blob_ref").notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("assets_user_path_key").on(t.userId, t.path)],
);

/**
 * Every write's history. `(asset_id, version)` is the natural key — versions are assigned
 * by the writer as `assets.current_version` is bumped, never reused. **Overwrites never
 * destroy the prior blob**: this table's old rows keep pointing at their own `blob_ref`,
 * which stays a valid `sha256:<hex>` key in the content-addressed store regardless of what
 * `assets.blob_ref` has moved on to — a property of `BlobStore` being content-addressed
 * (`packages/browser/src/blob-store.ts`), not a check this table or any code performs.
 */
export const assetVersions = pgTable(
  "asset_versions",
  {
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    blobRef: text("blob_ref").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    /** No `.references()`, deliberately — same reasoning as `endpointLeases.runId`: an
     * asset must outlive the run that wrote it (S5f), so this column is never cascade-deleted
     * when its run is. */
    runId: text("run_id"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.assetId, t.version] })],
);

/**
 * Per-task write scope (§13.5 decision 14): a task with at least one row here may write only
 * to a path matching one of its globs; a task with none may write anywhere under its own
 * user namespace (the `AllowAllGate` default, pre-Phase-7 — see `packages/assets/src/grants.ts`).
 * Reads are never grant-scoped, so this table has nothing to say about `assets.read`/`list`.
 */
export const assetWriteGrants = pgTable(
  "asset_write_grants",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    pathGlob: text("path_glob").notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.pathGlob] })],
);
// ---------------------------------------------------------------------------------------

// -- S5c: MCP servers (techical_plan §13, §14) ----------------------------------------
//
// One row per user-configured MCP server. `config_json` is zod-validated per `transport`
// in `packages/mcp` (stdio: command/args/env names; http: url) and **never carries a
// credential value** — a server that needs one names the env var or header it should land
// in, and the value comes from `secret_name` (nullable: most servers need no credential at
// all), resolved through the S5b broker at connect/call time. That is a schema-level
// property (there is no column here shaped to hold a secret), not a convention this table
// has to be trusted to honour.

export const MCP_TRANSPORTS = ["stdio", "http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    label: text("label").notNull(),
    transport: text("transport").$type<McpTransport>().notNull(),
    configJson: jsonb("config_json").notNull(),
    /** Names a row in `secrets` (S5b) — the credential *value* lives there, encrypted, and
     * never here. `null` for a server that needs no credential. */
    secretName: text("secret_name"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mcp_servers_user_label_key").on(t.userId, t.label),
    check("mcp_servers_transport_check", sql`${t.transport} in ('stdio','http')`),
  ],
);
// ---------------------------------------------------------------------------------------

// -- S5g: workflow data store (graph-compilation-llm §3, §9) --------------------------
//
// The *platform* half of the store — the artifact and the write-grant table. The workflow's
// actual data tables (`wfdata_<id>.*`) are never Drizzle models (style constraint: "no ORM
// inside wfdata_* schemas") — they are runtime objects `packages/store`'s migrator creates
// with hand-issued DDL, the only code path allowed to. `store_schemas` is this artifact's
// history, immutable per version (§6.2): each publish that touches the store schema writes a
// new row here and the migrator applies the classified diff, it never rewrites one in place.

export const STORE_MIGRATION_CLASSES = ["none", "additive", "destructive"] as const;
export type StoreMigrationClass = (typeof STORE_MIGRATION_CLASSES)[number];

export const storeSchemas = pgTable(
  "store_schemas",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    /** Monotonic per workflow (§6.2's `schema_version`) — matches the counter the migrator
     * also stamps on the runtime `wfdata_<id>._meta` row, so a compiled decision script can
     * guard on either and get the same number. */
    version: integer("version").notNull(),
    descriptionText: text("description_text").notNull().default(""),
    ddl: text("ddl").notNull(),
    tablesSpecJson: jsonb("tables_spec_json").notNull().default({}),
    /** Empty for `version` 1 (nothing to diff against) or class `none`. */
    migrationSql: text("migration_sql").notNull().default(""),
    migrationClass: text("migration_class").$type<StoreMigrationClass>().notNull().default("none"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("store_schemas_workflow_version_key").on(t.workflowId, t.version),
    check(
      "store_schemas_migration_class_check",
      sql`${t.migrationClass} in ('none','additive','destructive')`,
    ),
  ],
);

/**
 * Per-task write scope into the store — the exact `asset_write_grants` pattern (S5d) applied
 * to `store.insert`/`store.upsert` instead of the blob namespace: a task with at least one row
 * here may write only the named tables; a task with none may write any table the workflow's
 * store schema declares (the `AllowAllGate`-era default every ungranted write table follows
 * pre-Phase-7). Reads are never grant-scoped — `store.query` is open within the workflow, per
 * the reader role itself (§3.3), so this table has nothing to say about it.
 */
export const storeWriteGrants = pgTable(
  "store_write_grants",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tableName: text("table_name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tableName] })],
);
// ---------------------------------------------------------------------------------------

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
export type EngineStatusRow = typeof engineStatus.$inferSelect;
export type EndpointLeaseRow = typeof endpointLeases.$inferSelect;
export type SecretRow = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
export type SecretGrantRow = typeof secretGrants.$inferSelect;
export type SecretAccessLogRow = typeof secretAccessLog.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type AssetVersionRow = typeof assetVersions.$inferSelect;
export type AssetWriteGrantRow = typeof assetWriteGrants.$inferSelect;
export type McpServerRow = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
export type StoreSchemaRow = typeof storeSchemas.$inferSelect;
export type NewStoreSchema = typeof storeSchemas.$inferInsert;
export type StoreWriteGrantRow = typeof storeWriteGrants.$inferSelect;
