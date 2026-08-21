ALTER TABLE "tasks" DROP CONSTRAINT "tasks_kind_mode_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "code_source" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "code_sha256" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "runtime_json" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_mode_check" CHECK (not ("tasks"."kind" = 'asset' and "tasks"."mode" = 'compiled')
          and not ("tasks"."kind" <> 'asset' and "tasks"."mode" = 'python'));