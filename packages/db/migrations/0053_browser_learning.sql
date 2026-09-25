CREATE TABLE "browser_learning_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"content_hash" text,
	"definition_hash" text NOT NULL,
	"runtime_version" text NOT NULL,
	"context_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"heartbeat_at" timestamp with time zone,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"result_json" jsonb,
	"compile_requested" boolean DEFAULT false NOT NULL,
	"compile_job_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "browser_learning_jobs_status_check" CHECK ("browser_learning_jobs"."status" in ('queued','running','succeeded','refused','failed'))
);
--> statement-breakpoint
CREATE TABLE "browser_prompt_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"lane" text NOT NULL,
	"scope_key" text DEFAULT '' NOT NULL,
	"content_hash" text,
	"runtime_version" text NOT NULL,
	"source_run_id" text,
	"previous_revision_id" text,
	"baseline_prompt" text NOT NULL,
	"prompt" text NOT NULL,
	"data_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_prompt_revisions_lane_check" CHECK ("browser_prompt_revisions"."lane" in ('ai','deopt'))
);
--> statement-breakpoint
ALTER TABLE "compile_jobs" ADD COLUMN "learning_job_id" text;--> statement-breakpoint
ALTER TABLE "compile_jobs" ADD COLUMN "expected_script_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "baseline_compiled_prompt" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "learning_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "learning_runtime_version" text;--> statement-breakpoint
ALTER TABLE "browser_learning_jobs" ADD CONSTRAINT "browser_learning_jobs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_learning_jobs" ADD CONSTRAINT "browser_learning_jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_prompt_revisions" ADD CONSTRAINT "browser_prompt_revisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_prompt_revisions" ADD CONSTRAINT "browser_prompt_revisions_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_learning_jobs_run_key" ON "browser_learning_jobs" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_learning_jobs_running_task_key" ON "browser_learning_jobs" USING btree ("task_id") WHERE "browser_learning_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "browser_learning_jobs_claim_idx" ON "browser_learning_jobs" USING btree ("status","not_before");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_prompt_revisions_version_key" ON "browser_prompt_revisions" USING btree ("task_id","lane","scope_key","revision");--> statement-breakpoint
ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_learning_job_id_browser_learning_jobs_id_fk" FOREIGN KEY ("learning_job_id") REFERENCES "public"."browser_learning_jobs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
UPDATE "tasks" SET "baseline_compiled_prompt" = "compiled_prompt";
