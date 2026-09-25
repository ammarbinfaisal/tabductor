CREATE TABLE "browser_helpers" (
	"workflow_id" text NOT NULL,
	"task_name" text NOT NULL,
	"content_hash" text NOT NULL,
	"name" text NOT NULL,
	"revision" text NOT NULL,
	"source" text NOT NULL,
	"created_by_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_helpers_workflow_id_task_name_content_hash_name_revision_pk" PRIMARY KEY("workflow_id","task_name","content_hash","name","revision")
);
--> statement-breakpoint
ALTER TABLE "browser_helpers" ADD CONSTRAINT "browser_helpers_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_helpers" ADD CONSTRAINT "browser_helpers_created_by_run_id_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;