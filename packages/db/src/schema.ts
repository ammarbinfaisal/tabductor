import {
  type AnyPgColumn,
  bigint,
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
export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_human",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;
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
 * `decision` owns semantic work and the workflow store (`query`/`insert`/`upsert`). Both
 * kinds may be scheduled; browser alone can be compiled after trace validation.
 */
export const TASK_KINDS = ["browser", "decision", "result"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const accountIdentities = pgTable(
  "account_identities",
  {
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] }), index("account_identities_account_idx").on(t.accountId)],
);

export const accountMcpTokens = pgTable(
  "account_mcp_tokens",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    tokenSha256: text("token_sha256").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    label: text("label").notNull().default("MCP token"),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("account_mcp_tokens_hash_key").on(t.tokenSha256), index("account_mcp_tokens_account_idx").on(t.accountId)],
);

export const CREDIT_RESERVATION_STATUSES = ["active", "settled", "released", "expired"] as const;
export type CreditReservationStatus = (typeof CREDIT_RESERVATION_STATUSES)[number];
export const CREDIT_USAGE_CATEGORIES = ["browser", "model", "proxy", "solver", "other"] as const;
export type CreditUsageCategory = (typeof CREDIT_USAGE_CATEGORIES)[number];
export const CREDIT_LEDGER_KINDS = [
  "purchase",
  "adjustment",
  "refund",
  "reservation_hold",
  "reservation_release",
  "reservation_settlement",
] as const;
export type CreditLedgerKind = (typeof CREDIT_LEDGER_KINDS)[number];
export const PAYMENT_WEBHOOK_STATUSES = ["received", "pending", "processed", "failed"] as const;
export type PaymentWebhookStatus = (typeof PAYMENT_WEBHOOK_STATUSES)[number];
export const PAYMENT_PURCHASE_STATUSES = ["creating", "pending", "completed", "failed", "partially_refunded", "refunded"] as const;
export type PaymentPurchaseStatus = (typeof PAYMENT_PURCHASE_STATUSES)[number];
export const PAYMENT_ADJUSTMENT_ACTIONS = ["refund", "credit", "chargeback"] as const;
export type PaymentAdjustmentAction = (typeof PAYMENT_ADJUSTMENT_ACTIONS)[number];
export const PAYMENT_ADJUSTMENT_STATUSES = ["pending_approval", "approved", "rejected"] as const;
export type PaymentAdjustmentStatus = (typeof PAYMENT_ADJUSTMENT_STATUSES)[number];

/** A mutable operation record; money movement itself lives only in `credit_ledger_entries`. */
export const creditReservations = pgTable(
  "credit_reservations",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
    operationId: text("operation_id").notNull(),
    category: text("category").$type<CreditUsageCategory>().notNull(),
    reservedUnits: bigint("reserved_units", { mode: "number" }).notNull(),
    settledUnits: bigint("settled_units", { mode: "number" }),
    status: text("status").$type<CreditReservationStatus>().notNull().default("active"),
    expiresAt: ts("expires_at").notNull(),
    settledAt: ts("settled_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("credit_reservations_account_operation_key").on(t.accountId, t.operationId),
    index("credit_reservations_active_expiry_idx").on(t.status, t.expiresAt),
    check("credit_reservations_status_check", sql`${t.status} in ('active','settled','released','expired')`),
    check("credit_reservations_category_check", sql`${t.category} in ('browser','model','proxy','solver','other')`),
    check("credit_reservations_reserved_check", sql`${t.reservedUnits} > 0`),
    check("credit_reservations_settled_check", sql`${t.settledUnits} is null or (${t.settledUnits} >= 0 and ${t.settledUnits} <= ${t.reservedUnits})`),
  ],
);

/**
 * Signed, append-only available-credit movements. A reservation hold is negative; releasing
 * unused or abandoned credit is positive. Actual usage stays on the reservation, so no
 * mutable balance column can drift away from the audit trail.
 */
export const creditLedgerEntries = pgTable(
  "credit_ledger_entries",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
    reservationId: text("reservation_id").references(() => creditReservations.id, { onDelete: "restrict" }),
    kind: text("kind").$type<CreditLedgerKind>().notNull(),
    units: bigint("units", { mode: "number" }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("credit_ledger_entries_idempotency_key").on(t.idempotencyKey),
    index("credit_ledger_entries_account_created_idx").on(t.accountId, t.createdAt),
    index("credit_ledger_entries_reservation_idx").on(t.reservationId),
    check("credit_ledger_entries_kind_check", sql`${t.kind} in ('purchase','adjustment','refund','reservation_hold','reservation_release','reservation_settlement')`),
    check("credit_ledger_entries_units_check", sql`${t.units} <> 0`),
  ],
);

/** Verified Paddle deliveries. The exact parsed payload is retained for deterministic retry. */
export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    notificationId: text("notification_id").primaryKey(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<PaymentWebhookStatus>().notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    processedAt: ts("processed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("payment_webhook_events_event_key").on(t.eventId),
    index("payment_webhook_events_status_created_idx").on(t.status, t.createdAt),
    check("payment_webhook_events_status_check", sql`${t.status} in ('received','pending','processed','failed')`),
    check("payment_webhook_events_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

/** A server-created one-time credit-pack checkout. Credit quantity is pinned before Paddle is called. */
export const paymentPurchases = pgTable(
  "payment_purchases",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
    operationId: text("operation_id").notNull(),
    paddleTransactionId: text("paddle_transaction_id"),
    priceId: text("price_id").notNull(),
    creditUnits: bigint("credit_units", { mode: "number" }).notNull(),
    refundedUnits: bigint("refunded_units", { mode: "number" }).notNull().default(0),
    status: text("status").$type<PaymentPurchaseStatus>().notNull().default("creating"),
    checkoutUrl: text("checkout_url"),
    totalMinor: bigint("total_minor", { mode: "number" }),
    currencyCode: text("currency_code"),
    lastError: text("last_error"),
    creditedAt: ts("credited_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("payment_purchases_account_operation_key").on(t.accountId, t.operationId),
    uniqueIndex("payment_purchases_transaction_key").on(t.paddleTransactionId).where(sql`${t.paddleTransactionId} is not null`),
    index("payment_purchases_account_created_idx").on(t.accountId, t.createdAt),
    check("payment_purchases_status_check", sql`${t.status} in ('creating','pending','completed','failed','partially_refunded','refunded')`),
    check("payment_purchases_credit_units_check", sql`${t.creditUnits} > 0`),
    check("payment_purchases_refunded_units_check", sql`${t.refundedUnits} >= 0 and ${t.refundedUnits} <= ${t.creditUnits}`),
    check("payment_purchases_total_check", sql`${t.totalMinor} is null or ${t.totalMinor} > 0`),
  ],
);

/** Mutable Paddle adjustment state; the corresponding credit debit remains append-only. */
export const paymentAdjustments = pgTable(
  "payment_adjustments",
  {
    paddleAdjustmentId: text("paddle_adjustment_id").primaryKey(),
    purchaseId: text("purchase_id").notNull().references(() => paymentPurchases.id, { onDelete: "restrict" }),
    paddleTransactionId: text("paddle_transaction_id").notNull(),
    action: text("action").$type<PaymentAdjustmentAction>().notNull(),
    status: text("status").$type<PaymentAdjustmentStatus>().notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currencyCode: text("currency_code").notNull(),
    debitedUnits: bigint("debited_units", { mode: "number" }).notNull().default(0),
    lastEventId: text("last_event_id").notNull(),
    lastOccurredAt: ts("last_occurred_at").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("payment_adjustments_purchase_idx").on(t.purchaseId, t.createdAt),
    index("payment_adjustments_transaction_idx").on(t.paddleTransactionId),
    check("payment_adjustments_action_check", sql`${t.action} in ('refund','credit','chargeback')`),
    check("payment_adjustments_status_check", sql`${t.status} in ('pending_approval','approved','rejected')`),
    check("payment_adjustments_amount_check", sql`${t.amountMinor} > 0`),
    check("payment_adjustments_debited_check", sql`${t.debitedUnits} >= 0`),
  ],
);

export const workflows = pgTable("workflows", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  currentVersionId: text("current_version_id"),
  blockedReasonJson: jsonb("blocked_reason_json").$type<{ code: string; message: string }>(),
  maxHops: integer("max_hops").notNull().default(20),
  createdAt: createdAt(),
});

export const EXECUTION_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** One externally-triggered traversal, pinned to the version that accepted it. */
export const workflowExecutions = pgTable(
  "workflow_executions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "restrict" }),
    status: text("status").$type<ExecutionStatus>().notNull().default("running"),
    maxHops: integer("max_hops").notNull(),
    maxRuns: integer("max_runs").notNull().default(1000),
    admittedRuns: integer("admitted_runs").notNull().default(0),
    /** Non-secret model selection captured at trigger admission; null means no model was selected. */
    modelSelectionJson: jsonb("model_selection_json").$type<{
      funding: "byo" | "platform"; provider: "openai" | "anthropic" | "openai-compatible"; model: string; credentialId: string | null;
    }>(),
    blockedReasonJson: jsonb("blocked_reason_json").$type<{ code: string; message: string }>(),
    resultJson: jsonb("result_json"),
    resultReady: boolean("result_ready").notNull().default(false),
    endedAt: ts("ended_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("workflow_executions_workflow_created_idx").on(t.workflowId, t.createdAt),
    index("workflow_executions_status_idx").on(t.status),
    check("workflow_executions_status_check", sql`${t.status} in ('running','succeeded','failed','cancelled')`),
    check("workflow_executions_budget_check", sql`${t.maxRuns} > 0 and ${t.admittedRuns} >= 0`),
  ],
);

export const workflowVersions = pgTable("workflow_versions", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  graphJson: jsonb("graph_json").notNull().default({}),
  /** Store artifact active with this graph publication; null only before a store exists. */
  storeSchemaId: text("store_schema_id").references((): AnyPgColumn => storeSchemas.id, { onDelete: "set null" }),
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
    resultSchemaJson: jsonb("result_schema_json").$type<Record<string, unknown> | boolean>(),
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
    /** S8: capability-independent half used to recompute content_hash when grants change. */
    contentBasisHash: text("content_basis_hash"),
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
    check("tasks_kind_check", sql`${t.kind} in ('browser','decision','result')`),
    // Only browser tasks may carry an engine-produced compiled script. `mode` stays open so
    // test-only executors can register without a schema migration.
    check("tasks_kind_mode_check", sql`not (${t.kind} in ('decision','result') and ${t.mode} = 'compiled')`),
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
 * S6e — one row per **post-execution** compilation of a task's trace.
 *
 * Compilation is a separate task from the run that made it eligible (`trace-compilation.md`):
 * the run settles, flushes its trace and releases its session, and *then* this row is claimed
 * by the compile worker. The table is what makes "separate" true across a restart — an engine
 * that dies mid-compile leaves a `running` row whose lease goes stale, and the next worker
 * picks it up rather than losing the eligibility the run paid for.
 *
 * `content_hash` is the task content the job was enqueued against. The worker re-reads the
 * task before activating and refuses when it no longer matches: a compile that started before
 * an edit must never overwrite the definition that replaced it (graph-compilation-llm §6.3).
 */
export const COMPILE_JOB_STATUSES = ["queued", "running", "succeeded", "refused", "failed"] as const;
export type CompileJobStatus = (typeof COMPILE_JOB_STATUSES)[number];

/** Why a trace became eligible. `promote` is a first clean `ai` run; `recompile` is a deopt
 * the agent recovered, whose trace describes the layout that replaced the compiled one. */
export const COMPILE_JOB_REASONS = ["promote", "recompile"] as const;
export type CompileJobReason = (typeof COMPILE_JOB_REASONS)[number];

export const compileJobs = pgTable(
  "compile_jobs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** The run whose completed trace is the compile's primary evidence. */
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    reason: text("reason").$type<CompileJobReason>().notNull(),
    status: text("status").$type<CompileJobStatus>().notNull().default("queued"),
    /** The task's `content_hash` when the job was enqueued; `null` for a task that had none. */
    contentHash: text("content_hash"),
    attempts: integer("attempts").notNull().default(0),
    /** Compilation's own retry budget — separate from the run's, which is already spent. */
    maxAttempts: integer("max_attempts").notNull().default(2),
    /** Not before this instant: the backoff between attempts, and the small delay that lets
     * the engine settle the source run before its trace is read. */
    notBefore: ts("not_before").notNull().defaultNow(),
    /** Pinged by the worker holding the job; a stale one is reclaimable. */
    heartbeatAt: ts("heartbeat_at"),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    /** The candidate this job produced, once it has one. */
    scriptId: text("script_id"),
    /** The refusal, in the compiler's own words — what the author reads. */
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("compile_jobs_claim_idx").on(t.status, t.notBefore),
    // One open job per task: a second clean run while the first compile is still queued adds
    // evidence, not a second compile. The worker loads whatever traces exist when it runs.
    uniqueIndex("compile_jobs_open_task_key")
      .on(t.taskId)
      .where(sql`${t.status} in ('queued','running')`),
    check("compile_jobs_status_check", sql`${t.status} in ('queued','running','succeeded','refused','failed')`),
    check("compile_jobs_reason_check", sql`${t.reason} in ('promote','recompile')`),
  ],
);

export type CompileJobRow = typeof compileJobs.$inferSelect;

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
    recordJson: jsonb("record_json").$type<{ collection: string; key: string; status: RecordStatus }>(),
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
    /** Null only for legacy rows and platform events outside a workflow execution. */
    executionId: text("execution_id").references(() => workflowExecutions.id, { onDelete: "cascade" }),
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
  (t) => [index("events_causation_idx").on(t.causationId), index("events_execution_idx").on(t.executionId)],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id").references(() => workflowExecutions.id, { onDelete: "cascade" }),
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
    /** Incremented when an engine claims this run; stale owners cannot finish it. */
    leaseGeneration: integer("lease_generation").notNull().default(0),
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
    index("runs_execution_idx").on(t.executionId),
  ],
);

// -- S7: policy grants, account baseline and attended approvals -------------------------

/**
 * A capability granted to one task. `grant_key` names the capability family and
 * `grant_value` is the narrow member inside it (a hostname, tool id, action name, or `*`).
 * Keeping both columns as text makes equality and prefix matching explicit at the evaluator
 * and gives S8 a stable artifact to propose without letting its compiler write this table.
 */
export const taskGrants = pgTable(
  "task_grants",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    grantKey: text("grant_key").notNull(),
    grantValue: text("grant_value").notNull(),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.grantKey, t.grantValue] })],
);

/**
 * The non-overridable account floor. The evaluator validates `rule_json` before using it;
 * malformed rows fail closed instead of silently disappearing from the baseline.
 */
export const accountBaselineRules = pgTable(
  "account_baseline_rules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    ruleJson: jsonb("rule_json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("account_baseline_rules_user_idx").on(t.userId)],
);

export const APPROVAL_STATUSES = ["pending", "granted", "denied", "expired", "cancelled"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * One parked policy decision. The browser executor remains alive while this row is pending;
 * the control plane changes only `status`, and the waiting evaluator resumes or refuses the
 * exact intercepted action. `request_json` is diagnostic context, never credential content.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    check: text("check").notNull(),
    rule: text("rule").notNull(),
    requestJson: jsonb("request_json").notNull().default({}),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("approvals_run_idx").on(t.runId),
    index("approvals_pending_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);
// ---------------------------------------------------------------------------------------

// -- S8: graph-authoring compiler artifacts ----------------------------------------------

export const PROPOSED_GRANT_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "stripped_by_baseline",
] as const;
export type ProposedGrantStatus = (typeof PROPOSED_GRANT_STATUSES)[number];

export const proposedGrants = pgTable(
  "proposed_grants",
  {
    id: text("id").primaryKey(),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    taskRef: text("task_ref").notNull(),
    grantKey: text("grant_key").notNull(),
    grantValue: text("grant_value").notNull(),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    status: text("status").$type<ProposedGrantStatus>().notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [
    index("proposed_grants_version_idx").on(t.workflowVersionId),
    uniqueIndex("proposed_grants_identity_key").on(t.workflowVersionId, t.taskRef, t.grantKey, t.grantValue),
    check(
      "proposed_grants_status_check",
      sql`${t.status} in ('pending','approved','rejected','stripped_by_baseline')`,
    ),
  ],
);

export const compileReports = pgTable("compile_reports", {
  workflowVersionId: text("workflow_version_id")
    .primaryKey()
    .references(() => workflowVersions.id, { onDelete: "cascade" }),
  reportJson: jsonb("report_json").notNull(),
  createdAt: createdAt(),
});
// ---------------------------------------------------------------------------------------

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
  "runtime",
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

/** Immutable, task-scoped SDK helper revisions. Never shared across accounts/workflows. */
export const browserHelpers = pgTable("browser_helpers", {
  language: text("language").notNull().default("javascript"),
  workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  taskName: text("task_name").notNull(),
  contentHash: text("content_hash").notNull(),
  name: text("name").notNull(),
  revision: text("revision").notNull(),
  source: text("source").notNull(),
  createdByRunId: text("created_by_run_id").references(() => runs.id, { onDelete: "set null" }),
  createdAt: createdAt(),
}, t => [primaryKey({ columns: [t.workflowId, t.taskName, t.contentHash, t.name, t.revision] }),
  check("browser_helpers_language_check", sql`${t.language} IN ('javascript', 'python')`)]);

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

export const BROWSER_SESSION_STATUSES = [
  "queued", "allocating", "ready", "running", "stopping", "ended", "failed",
] as const;
export type BrowserSessionStatus = (typeof BROWSER_SESSION_STATUSES)[number];
export const BROWSER_WORKER_STATUSES = ["warm", "allocated", "draining", "dead"] as const;
export type BrowserWorkerStatus = (typeof BROWSER_WORKER_STATUSES)[number];
export const BROWSER_RECORDING_STATUSES = ["unavailable", "recording", "partial", "complete", "expired"] as const;
export type BrowserRecordingStatus = (typeof BROWSER_RECORDING_STATUSES)[number];
export const BROWSER_RECORDING_SEGMENT_STATUSES = ["ready", "gap", "private"] as const;
export type BrowserRecordingSegmentStatus = (typeof BROWSER_RECORDING_SEGMENT_STATUSES)[number];
export const BROWSER_INPUT_OWNERS = ["ai", "human", "paused"] as const;
export type BrowserInputOwner = (typeof BROWSER_INPUT_OWNERS)[number];

export const browserProfiles = pgTable(
  "browser_profiles",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    snapshotBlobRef: text("snapshot_blob_ref"),
    pendingAuthEnvelope: jsonb("pending_auth_envelope").$type<{ ciphertext: string; nonce: string; wrapped: string; kekRef: string }>(),
    snapshotGeneration: integer("snapshot_generation").notNull().default(0),
    fingerprintJson: jsonb("fingerprint_json").notNull().default({}),
    proxyRef: text("proxy_ref"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("browser_profiles_account_name_key").on(t.accountId, t.name),
    index("browser_profiles_account_idx").on(t.accountId),
  ],
);

export const browserSessions = pgTable(
  "browser_sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    executionId: text("execution_id").references(() => workflowExecutions.id, { onDelete: "set null" }),
    profileId: text("profile_id").notNull().references(() => browserProfiles.id, { onDelete: "restrict" }),
    status: text("status").$type<BrowserSessionStatus>().notNull().default("queued"),
    generation: integer("generation").notNull().default(1),
    workerId: text("worker_id"),
    podName: text("pod_name"),
    inputOwner: text("input_owner").$type<BrowserInputOwner>().notNull().default("ai"),
    inputOwnerGeneration: integer("input_owner_generation").notNull().default(1),
    automationAcknowledgedGeneration: integer("automation_acknowledged_generation").notNull().default(1),
    pauseRequestedAt: ts("pause_requested_at"),
    pauseAcknowledgedAt: ts("pause_acknowledged_at"),
    takeoverExpiresAt: ts("takeover_expires_at"),
    humanActionPending: boolean("human_action_pending").notNull().default(false),
    recordingStatus: text("recording_status").$type<BrowserRecordingStatus>().notNull().default("unavailable"),
    recordingStartedAt: ts("recording_started_at"),
    recordingEndedAt: ts("recording_ended_at"),
    readyAt: ts("ready_at"),
    heartbeatAt: ts("heartbeat_at"),
    endedAt: ts("ended_at"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("browser_sessions_account_created_idx").on(t.accountId, t.createdAt),
    index("browser_sessions_status_idx").on(t.status),
    check("browser_sessions_status_check", sql`${t.status} in ('queued','allocating','ready','running','stopping','ended','failed')`),
    check("browser_sessions_input_owner_check", sql`${t.inputOwner} in ('ai','human','paused')`),
    check("browser_sessions_recording_status_check", sql`${t.recordingStatus} in ('unavailable','recording','partial','complete','expired')`),
  ],
);

/** Reusable tab slots, exclusively leased to one packet run at a time. */
export const browserTabLeases = pgTable("browser_tab_leases", {
  sessionId: text("session_id").notNull().references(() => browserSessions.id, { onDelete: "cascade" }),
  tabKey: text("tab_key").notNull(),
  runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
  runGeneration: integer("run_generation"),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
}, (t) => [primaryKey({ columns: [t.sessionId, t.tabKey] })]);

/** Durable, cursor-addressable session activity. Payloads are metadata only: callers must
 * never put credential values, human keystrokes, or page bodies in this table. */
export const browserSessionActivity = pgTable(
  "browser_session_activity",
  {
    cursor: bigserial("cursor", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull().references(() => browserSessions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    offsetMs: integer("offset_ms").notNull().default(0),
    pageId: text("page_id"),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull().default({}),
    private: boolean("private").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("browser_session_activity_session_cursor_idx").on(t.sessionId, t.cursor),
    check("browser_session_activity_offset_check", sql`${t.offsetMs} >= 0`),
  ],
);

/** Recoverable HLS metadata. A gap/private row intentionally has no object reference and
 * keeps playback time aligned without claiming media exists for that interval. */
export const browserRecordingSegments = pgTable(
  "browser_recording_segments",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => browserSessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    status: text("status").$type<BrowserRecordingSegmentStatus>().notNull(),
    objectRef: text("object_ref"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("browser_recording_segments_session_sequence_key").on(t.sessionId, t.sequence),
    index("browser_recording_segments_session_time_idx").on(t.sessionId, t.startMs),
    check("browser_recording_segments_time_check", sql`${t.startMs} >= 0 and ${t.endMs} > ${t.startMs}`),
    check("browser_recording_segments_status_check", sql`${t.status} in ('ready','gap','private')`),
    check("browser_recording_segments_object_check", sql`(${t.status} = 'ready' and ${t.objectRef} is not null) or (${t.status} <> 'ready' and ${t.objectRef} is null)`),
  ],
);

export const browserProfileLeases = pgTable("browser_profile_leases", {
  profileId: text("profile_id").primaryKey().references(() => browserProfiles.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => browserSessions.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull(),
  heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
});

/** Single-use, origin-scoped capabilities; plaintext tokens are never stored. */
export const browserProfileImports = pgTable("browser_profile_imports", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  profileId: text("profile_id").notNull().references(() => browserProfiles.id, { onDelete: "cascade" }),
  origin: text("origin").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const browserAllocationRequests = pgTable(
  "browser_allocation_requests",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().references(() => browserSessions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    notBefore: ts("not_before").notNull().defaultNow(),
    claimedAt: ts("claimed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("browser_allocation_requests_session_key").on(t.sessionId),
    index("browser_allocation_requests_queue_idx").on(t.status, t.notBefore, t.createdAt),
    check("browser_allocation_requests_status_check", sql`${t.status} in ('queued','claimed','fulfilled','failed','cancelled')`),
  ],
);

export const browserWorkers = pgTable(
  "browser_workers",
  {
    id: text("id").primaryKey(),
    podName: text("pod_name").notNull(),
    endpointUrl: text("endpoint_url"),
    status: text("status").$type<BrowserWorkerStatus>().notNull().default("warm"),
    sessionId: text("session_id").references(() => browserSessions.id, { onDelete: "set null" }),
    generation: integer("generation").notNull().default(0),
    heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("browser_workers_pod_key").on(t.podName),
    uniqueIndex("browser_workers_live_session_key").on(t.sessionId).where(sql`${t.sessionId} is not null and ${t.status} = 'allocated'`),
    index("browser_workers_status_idx").on(t.status),
    check("browser_workers_status_check", sql`${t.status} in ('warm','allocated','draining','dead')`),
  ],
);

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
  "denied_grant",
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
 * Per-task write scope into the store: a decision with at least one row
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
export type TaskGrantRow = typeof taskGrants.$inferSelect;
export type AccountBaselineRuleRow = typeof accountBaselineRules.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type ProposedGrantRow = typeof proposedGrants.$inferSelect;
export type CompileReportRow = typeof compileReports.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type EventDefRow = typeof eventDefs.$inferSelect;
export type TaskEmitRow = typeof taskEmits.$inferSelect;
export type TaskConsumeRow = typeof taskConsumes.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowExecutionRow = typeof workflowExecutions.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type AccountIdentityRow = typeof accountIdentities.$inferSelect;
export type AccountMcpTokenRow = typeof accountMcpTokens.$inferSelect;
export type CreditReservationRow = typeof creditReservations.$inferSelect;
export type CreditLedgerEntryRow = typeof creditLedgerEntries.$inferSelect;
export type PaymentWebhookEventRow = typeof paymentWebhookEvents.$inferSelect;
export type PaymentPurchaseRow = typeof paymentPurchases.$inferSelect;
export type PaymentAdjustmentRow = typeof paymentAdjustments.$inferSelect;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type WorkflowShareRow = typeof workflowShares.$inferSelect;
export type CdpEndpointRow = typeof cdpEndpoints.$inferSelect;
export type NewCdpEndpoint = typeof cdpEndpoints.$inferInsert;
export type EngineStatusRow = typeof engineStatus.$inferSelect;
export type EndpointLeaseRow = typeof endpointLeases.$inferSelect;
export type BrowserProfileRow = typeof browserProfiles.$inferSelect;
export type BrowserSessionRow = typeof browserSessions.$inferSelect;
export type BrowserProfileLeaseRow = typeof browserProfileLeases.$inferSelect;
export type BrowserAllocationRequestRow = typeof browserAllocationRequests.$inferSelect;
export type BrowserWorkerRow = typeof browserWorkers.$inferSelect;
export type BrowserSessionActivityRow = typeof browserSessionActivity.$inferSelect;
export type BrowserRecordingSegmentRow = typeof browserRecordingSegments.$inferSelect;
export type SecretRow = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
export type SecretGrantRow = typeof secretGrants.$inferSelect;
export type SecretAccessLogRow = typeof secretAccessLog.$inferSelect;
export type StoreSchemaRow = typeof storeSchemas.$inferSelect;
export type NewStoreSchema = typeof storeSchemas.$inferInsert;
export type StoreWriteGrantRow = typeof storeWriteGrants.$inferSelect;

export const modelCredentials = pgTable("model_credentials", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  provider: text("provider").$type<"openai" | "anthropic" | "openai-compatible">().notNull(),
  label: text("label").notNull(),
  /** A non-secret API root, set only for OpenAI-compatible credentials. */
  baseUrl: text("base_url"),
  envelope: jsonb("envelope").$type<{ ciphertext: string; nonce: string; wrapped: string; kekRef: string }>().notNull(),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
}, (t) => [index("model_credentials_account_idx").on(t.accountId)]);

/** scope is 'account' or a workflow id. Credentials are never part of a graph artifact. */
export const modelSelections = pgTable("model_selections", {
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  funding: text("funding").$type<"byo" | "platform">().notNull(),
  provider: text("provider").$type<"openai" | "anthropic" | "openai-compatible">().notNull(),
  model: text("model").notNull(),
  credentialId: text("credential_id").references(() => modelCredentials.id, { onDelete: "restrict" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.accountId, t.scope] }),
  check("model_selections_funding_check", sql`(${t.funding} = 'byo' and ${t.credentialId} is not null) or (${t.funding} = 'platform' and ${t.credentialId} is null)`)]);

/** Each outbound model call is admitted durably before contacting the provider. */
export const modelOperations = pgTable("model_operations", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  workflowId: text("workflow_id").references(() => workflows.id, { onDelete: "restrict" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "restrict" }),
  purpose: text("purpose").notNull(),
  funding: text("funding").$type<"byo" | "platform">().notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  rateVersion: text("rate_version"),
  rateJson: jsonb("rate_json").$type<{ input: number; cachedInput: number; output: number }>(),
  reservationId: text("reservation_id").references(() => creditReservations.id, { onDelete: "restrict" }),
  status: text("status").$type<"pending" | "succeeded" | "uncertain">().notNull().default("pending"),
  inputTokens: integer("input_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  chargedUnits: bigint("charged_units", { mode: "number" }),
  createdAt: createdAt(),
  completedAt: ts("completed_at"),
}, (t) => [index("model_operations_account_created_idx").on(t.accountId, t.createdAt),
  check("model_operations_status_check", sql`${t.status} in ('pending','succeeded','uncertain')`)]);

export const workflowBrowserProfiles = pgTable("workflow_browser_profiles", {
  workflowId: text("workflow_id").primaryKey().references(() => workflows.id, { onDelete: "cascade" }),
  profileId: text("profile_id").notNull().references(() => browserProfiles.id, { onDelete: "restrict" }),
});

/** Metadata only; neither command arguments nor results may contain persisted secrets. */
export const browserCommands = pgTable("browser_commands", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => browserSessions.id, { onDelete: "restrict" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "restrict" }),
  runGeneration: integer("run_generation"),
  generation: integer("generation").notNull(),
  inputGeneration: integer("input_generation").notNull(),
  method: text("method").notNull(),
  status: text("status").$type<"pending" | "succeeded" | "uncertain" | "rejected">().notNull().default("pending"),
  createdAt: createdAt(),
  completedAt: ts("completed_at"),
}, (t) => [index("browser_commands_session_idx").on(t.sessionId, t.createdAt)]);

export const browserBilling = pgTable("browser_billing", {
  sessionId: text("session_id").primaryKey().references(() => browserSessions.id, { onDelete: "restrict" }),
  reservationId: text("reservation_id").notNull().references(() => creditReservations.id, { onDelete: "restrict" }),
  rateVersion: text("rate_version").notNull(),
  unitsPerMinute: integer("units_per_minute").notNull(),
  maxSeconds: integer("max_seconds").notNull(),
  startedAt: ts("started_at").notNull().defaultNow(),
  endedAt: ts("ended_at"),
});

export const workflowTriggerRequests = pgTable("workflow_trigger_requests", {
  workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "restrict" }),
  requestId: text("request_id").notNull(),
  resultJson: jsonb("result_json").$type<{ workflowId: string; executionId: string; accepted: number;
    runs: Array<{ eventId: string; type: string; runId: string | null }> }>().notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.workflowId, t.requestId] })]);

export const browserChallenges = pgTable("browser_challenges", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => browserSessions.id, { onDelete: "restrict" }),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  identity: text("identity").notNull(),
  kind: text("kind").notNull(),
  websiteUrl: text("website_url").notNull(),
  siteKey: text("site_key").notNull(),
  status: text("status").$type<"pending" | "solved" | "human_required">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  deadline: ts("deadline").notNull(),
  nextPollAt: ts("next_poll_at").notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("browser_challenges_identity_key").on(t.sessionId, t.identity)]);

export const challengeAttempts = pgTable("challenge_attempts", {
  id: text("id").primaryKey(),
  challengeId: text("challenge_id").notNull().references(() => browserChallenges.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  providerTaskId: text("provider_task_id"),
  rateVersion: text("rate_version").notNull(),
  creditUnits: integer("credit_units").notNull(),
  reservationId: text("reservation_id").notNull().references(() => creditReservations.id, { onDelete: "restrict" }),
  status: text("status").$type<"submitting" | "submitted" | "rejected" | "applying" | "solved" | "invalid" | "uncertain">().notNull(),
  createdAt: createdAt(),
}, (t) => [index("challenge_attempts_challenge_idx").on(t.challengeId)]);

/** Durable native CAPTCHA jobs; request bodies and provider keys are never stored. */
export const captchaJobs = pgTable("captcha_jobs", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(),
  requestDigest: text("request_digest").notNull(),
  provider: text("provider").notNull(),
  taskType: text("task_type").notNull(),
  providerTaskId: text("provider_task_id"),
  status: text("status").$type<"submitting" | "pending" | "ready" | "failed" | "uncertain">().notNull(),
  solutionJson: jsonb("solution_json").$type<Record<string, unknown>>(),
  errorCode: text("error_code"),
  rateVersion: text("rate_version").notNull(),
  creditUnits: integer("credit_units").notNull(),
  reservationId: text("reservation_id").notNull().references(() => creditReservations.id, { onDelete: "restrict" }),
  nextPollAt: ts("next_poll_at").notNull().defaultNow(),
  createdAt: createdAt(),
}, t => [uniqueIndex("captcha_jobs_run_key").on(t.runId, t.idempotencyKey)]);

/** Verified business progress is separate from task and event counts. */
export const RECORD_STATUSES = ["extracted", "prepared", "pending", "saved", "skipped", "rejected", "failed"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
export const workflowRecords = pgTable("workflow_records", {
  executionId: text("execution_id").notNull().references(() => workflowExecutions.id, { onDelete: "cascade" }),
  collection: text("collection").notNull(),
  recordKey: text("record_key").notNull(),
  sourceEventId: uuid("source_event_id").notNull().references(() => events.eventId),
  status: text("status").$type<RecordStatus>().notNull(),
  lastRunId: text("last_run_id").references(() => runs.id),
  reason: text("reason"),
  verificationJson: jsonb("verification_json").$type<{ snapshotId?: string; assessmentId?: string; method?: "readback" | "ai-assessment"; url: string; recordKey?: string; checkedAt: string }>(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.executionId, t.collection, t.recordKey] }),
  check("workflow_records_status_check", sql`${t.status} in ('extracted','prepared','pending','saved','skipped','rejected','failed')`),
  check("workflow_records_saved_check", sql`${t.status} <> 'saved' or ${t.verificationJson} is not null`)]);
export const runRecordOutcomes = pgTable("run_record_outcomes", {
  runId: text("run_id").primaryKey().references(() => runs.id, { onDelete: "cascade" }),
  status: text("status").$type<RecordStatus>().notNull(),
  reason: text("reason").notNull(),
  verificationJson: jsonb("verification_json").$type<{ snapshotId?: string; assessmentId?: string; method?: "readback" | "ai-assessment"; url: string; recordKey?: string; checkedAt: string }>(),
  createdAt: createdAt(),
});

/** Controller health includes fleets that intentionally keep zero warm workers. */
export const browserFleetStatus = pgTable("browser_fleet_status", {
  id: text("id").primaryKey(),
  maxAllocated: integer("max_allocated").notNull(),
  heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
});

/** Execution-scoped, immutable website mappings. Publication and readiness are atomic. */
export const destinationPreparations = pgTable("destination_preparations", {
  executionId: text("execution_id").notNull().references(() => workflowExecutions.id, { onDelete: "cascade" }),
  destinationKey: text("destination_key").notNull(),
  ownerRunId: text("owner_run_id").notNull().references(() => runs.id),
  leaseGeneration: integer("lease_generation").notNull(),
  status: text("status").$type<"preparing" | "ready">().notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.executionId, t.destinationKey] })]);

export const destinationContracts = pgTable("destination_contracts", {
  id: text("id").primaryKey(),
  executionId: text("execution_id").notNull().references(() => workflowExecutions.id, { onDelete: "cascade" }),
  destinationKey: text("destination_key").notNull(),
  revision: integer("revision").notNull(),
  createdByRunId: text("created_by_run_id").notNull().references(() => runs.id),
  contractJson: jsonb("contract_json").$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
}, t => [uniqueIndex("destination_contract_revision_key").on(t.executionId, t.destinationKey, t.revision)]);

/** Cross-execution identity ledger; pending effects must be reconciled after a crash. */
export const destinationRecords = pgTable("destination_records", {
  workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  destinationKey: text("destination_key").notNull(),
  recordKey: text("record_key").notNull(),
  ownerRunId: text("owner_run_id").notNull().references(() => runs.id),
  leaseGeneration: integer("lease_generation").notNull(),
  status: text("status").$type<"pending" | "saved">().notNull(),
  verificationJson: jsonb("verification_json").$type<Record<string, unknown>>(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.workflowId, t.destinationKey, t.recordKey] }),
  check("destination_records_saved_check", sql`${t.status} <> 'saved' or ${t.verificationJson} is not null`)]);

export const humanActionRequests = pgTable("human_action_requests", {
  runId: text("run_id").primaryKey().references(() => runs.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => browserSessions.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(), resumeWhen: text("resume_when").notNull(),
  status: text("status").$type<"pending" | "resumed">().notNull().default("pending"),
  createdAt: createdAt(), resumedAt: ts("resumed_at"),
});
