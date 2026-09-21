ALTER TABLE "tasks" DROP CONSTRAINT "tasks_kind_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_kind_mode_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "result_schema_json" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "result_json" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "result_ready" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK ("tasks"."kind" in ('browser','decision','result'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_mode_check" CHECK (not ("tasks"."kind" in ('decision','result') and "tasks"."mode" = 'compiled'));