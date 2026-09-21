CREATE TABLE "destination_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"destination_key" text NOT NULL,
	"revision" integer NOT NULL,
	"created_by_run_id" text NOT NULL,
	"contract_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "destination_records" (
	"workflow_id" text NOT NULL,
	"destination_key" text NOT NULL,
	"record_key" text NOT NULL,
	"owner_run_id" text NOT NULL,
	"lease_generation" integer NOT NULL,
	"status" text NOT NULL,
	"verification_json" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destination_records_workflow_id_destination_key_record_key_pk" PRIMARY KEY("workflow_id","destination_key","record_key"),
	CONSTRAINT "destination_records_saved_check" CHECK ("destination_records"."status" <> 'saved' or "destination_records"."verification_json" is not null)
);
--> statement-breakpoint
CREATE TABLE "human_action_requests" (
	"run_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"reason" text NOT NULL,
	"resume_when" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "destination_contracts" ADD CONSTRAINT "destination_contracts_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination_contracts" ADD CONSTRAINT "destination_contracts_created_by_run_id_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination_records" ADD CONSTRAINT "destination_records_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination_records" ADD CONSTRAINT "destination_records_owner_run_id_runs_id_fk" FOREIGN KEY ("owner_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_action_requests" ADD CONSTRAINT "human_action_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_action_requests" ADD CONSTRAINT "human_action_requests_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "destination_contract_revision_key" ON "destination_contracts" USING btree ("execution_id","destination_key","revision");