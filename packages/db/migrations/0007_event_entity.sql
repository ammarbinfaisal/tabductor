-- The event becomes a workflow-version-scoped entity (event-centric model):
-- event_defs re-keys from (task, type) to (version, type) and gains the author's
-- description prompt + the compiler's carry-forward hash; emission and consumption
-- move to task_emits/task_consumes; the authored edges table is dropped — topology
-- is derived by matching event types. Generated DDL with hand-interleaved backfill.
CREATE TABLE "task_consumes" (
	"task_id" text NOT NULL,
	"workflow_version_id" text NOT NULL,
	"event_type" text NOT NULL,
	CONSTRAINT "task_consumes_task_id_event_type_pk" PRIMARY KEY("task_id","event_type")
);
--> statement-breakpoint
CREATE TABLE "task_emits" (
	"task_id" text NOT NULL,
	"workflow_version_id" text NOT NULL,
	"event_type" text NOT NULL,
	CONSTRAINT "task_emits_task_id_event_type_pk" PRIMARY KEY("task_id","event_type")
);
--> statement-breakpoint
ALTER TABLE "task_consumes" ADD CONSTRAINT "task_consumes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_consumes" ADD CONSTRAINT "task_consumes_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_emits" ADD CONSTRAINT "task_emits_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_emits" ADD CONSTRAINT "task_emits_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_consumes_routing_idx" ON "task_consumes" USING btree ("workflow_version_id","event_type");--> statement-breakpoint
-- Backfill: every old per-emitter declaration becomes an emit edge; every edge's
-- target becomes a subscription.
INSERT INTO "task_emits" ("task_id", "workflow_version_id", "event_type")
SELECT d."task_id", t."workflow_version_id", d."event_type"
FROM "event_defs" d JOIN "tasks" t ON t."id" = d."task_id";--> statement-breakpoint
INSERT INTO "task_consumes" ("task_id", "workflow_version_id", "event_type")
SELECT DISTINCT e."to_task_id", e."workflow_version_id", e."event_type" FROM "edges" e;--> statement-breakpoint
ALTER TABLE "edges" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "edges" CASCADE;--> statement-breakpoint
ALTER TABLE "event_defs" DROP CONSTRAINT "event_defs_task_id_tasks_id_fk";
--> statement-breakpoint
DROP INDEX "event_defs_task_type_key";--> statement-breakpoint
ALTER TABLE "event_defs" ADD COLUMN "workflow_version_id" text;--> statement-breakpoint
ALTER TABLE "event_defs" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_defs" ADD COLUMN "prompt_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "event_defs" d SET "workflow_version_id" = t."workflow_version_id" FROM "tasks" t WHERE t."id" = d."task_id";--> statement-breakpoint
-- Two emitters of one type used to hold two rows; the entity holds one. `public`
-- collapses with bool_or — the enforcement side (publicEventTypes) already unioned
-- per type, so no share viewer sees more than before. The surviving row's schema is
-- pick-any; prompt_hash stays '' so the next publish recompiles it regardless.
UPDATE "event_defs" d SET "public" = g."pub" FROM (
  SELECT "workflow_version_id", "event_type", bool_or("public") AS "pub"
  FROM "event_defs" GROUP BY "workflow_version_id", "event_type"
) g WHERE g."workflow_version_id" = d."workflow_version_id" AND g."event_type" = d."event_type";--> statement-breakpoint
DELETE FROM "event_defs" a USING "event_defs" b
WHERE a."workflow_version_id" = b."workflow_version_id" AND a."event_type" = b."event_type" AND a."id" > b."id";--> statement-breakpoint
ALTER TABLE "event_defs" ALTER COLUMN "workflow_version_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "event_defs" ADD CONSTRAINT "event_defs_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_defs_version_type_key" ON "event_defs" USING btree ("workflow_version_id","event_type");--> statement-breakpoint
ALTER TABLE "event_defs" DROP COLUMN "task_id";
