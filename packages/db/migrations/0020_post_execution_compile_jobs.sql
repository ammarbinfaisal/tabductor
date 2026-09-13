CREATE TABLE "compile_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"content_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"script_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compile_jobs_status_check" CHECK ("compile_jobs"."status" in ('queued','running','succeeded','refused','failed')),
	CONSTRAINT "compile_jobs_reason_check" CHECK ("compile_jobs"."reason" in ('promote','recompile'))
);
--> statement-breakpoint
ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compile_jobs_claim_idx" ON "compile_jobs" USING btree ("status","not_before");--> statement-breakpoint
CREATE UNIQUE INDEX "compile_jobs_open_task_key" ON "compile_jobs" USING btree ("task_id") WHERE "compile_jobs"."status" in ('queued','running');