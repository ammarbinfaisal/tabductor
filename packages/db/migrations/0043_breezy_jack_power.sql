CREATE TABLE "run_record_outcomes" (
	"run_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"verification_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_records" (
	"execution_id" text NOT NULL,
	"collection" text NOT NULL,
	"record_key" text NOT NULL,
	"source_event_id" uuid NOT NULL,
	"status" text NOT NULL,
	"last_run_id" text,
	"reason" text,
	"verification_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_records_execution_id_collection_record_key_pk" PRIMARY KEY("execution_id","collection","record_key"),
	CONSTRAINT "workflow_records_status_check" CHECK ("workflow_records"."status" in ('extracted','prepared','pending','saved','skipped','rejected','failed')),
	CONSTRAINT "workflow_records_saved_check" CHECK ("workflow_records"."status" <> 'saved' or "workflow_records"."verification_json" is not null)
);
--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN "automation_acknowledged_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_defs" ADD COLUMN "record_json" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "blocked_reason_json" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "blocked_reason_json" jsonb;--> statement-breakpoint
ALTER TABLE "run_record_outcomes" ADD CONSTRAINT "run_record_outcomes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_records" ADD CONSTRAINT "workflow_records_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_records" ADD CONSTRAINT "workflow_records_source_event_id_events_event_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_records" ADD CONSTRAINT "workflow_records_last_run_id_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;