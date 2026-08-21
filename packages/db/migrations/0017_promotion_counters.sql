ALTER TABLE "tasks" ADD COLUMN "clean_ai_runs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "recent_deopts" jsonb DEFAULT '[]'::jsonb NOT NULL;