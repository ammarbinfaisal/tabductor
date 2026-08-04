import {
  bigserial,
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

export const edges = pgTable(
  "edges",
  {
    id: text("id").primaryKey(),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    fromTaskId: text("from_task_id").references(() => tasks.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    toTaskId: text("to_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    predicate: text("predicate"),
  },
  (t) => [index("edges_routing_idx").on(t.workflowVersionId, t.eventType)],
);

export const eventDefs = pgTable(
  "event_defs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    packetSchemaJson: jsonb("packet_schema_json").notNull().default({}),
  },
  (t) => [uniqueIndex("event_defs_task_type_key").on(t.taskId, t.eventType)],
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
    status: text("status").notNull().default("queued"),
    modeUsed: text("mode_used").notNull(),
    attempt: integer("attempt").notNull().default(0),
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
  },
  (t) => [
    index("outbox_pending_idx")
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const schedules = pgTable("schedules", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  cron: text("cron").notNull(),
  tz: text("tz").notNull().default("UTC"),
  missedPolicy: text("missed_policy").notNull().default("skip"),
  overlapPolicy: text("overlap_policy").notNull().default("skip"),
  lastFiredAt: ts("last_fired_at"),
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

export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type OutboxRow = typeof outbox.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type EdgeRow = typeof edges.$inferSelect;
export type EventDefRow = typeof eventDefs.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
