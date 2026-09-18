CREATE TABLE "workflow_trigger_requests" (
	"workflow_id" text NOT NULL,
	"request_id" text NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_trigger_requests_workflow_id_request_id_pk" PRIMARY KEY("workflow_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "workflow_trigger_requests" ADD CONSTRAINT "workflow_trigger_requests_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE restrict ON UPDATE no action;