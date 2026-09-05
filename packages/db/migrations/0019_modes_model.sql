ALTER TABLE "tasks" DROP CONSTRAINT "tasks_kind_mode_check";--> statement-breakpoint
ALTER TABLE "engine_status" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "compiled_prompt" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "compiled_prompt_hash" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_mode_check" CHECK (not ("tasks"."kind" = 'asset' and "tasks"."mode" = 'compiled'));--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "code_source";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "code_sha256";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "runtime_json";
