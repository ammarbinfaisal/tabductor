CREATE TABLE "destination_preparations" (
	"execution_id" text NOT NULL,
	"destination_key" text NOT NULL,
	"owner_run_id" text NOT NULL,
	"lease_generation" integer NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destination_preparations_execution_id_destination_key_pk" PRIMARY KEY("execution_id","destination_key")
);
--> statement-breakpoint
ALTER TABLE "destination_preparations" ADD CONSTRAINT "destination_preparations_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination_preparations" ADD CONSTRAINT "destination_preparations_owner_run_id_runs_id_fk" FOREIGN KEY ("owner_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;