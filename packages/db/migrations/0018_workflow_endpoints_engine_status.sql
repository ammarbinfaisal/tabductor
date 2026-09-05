CREATE TABLE "engine_status" (
	"id" text PRIMARY KEY NOT NULL,
	"executors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"booted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cdp_endpoints" ADD COLUMN "workflow_id" text;--> statement-breakpoint
ALTER TABLE "cdp_endpoints" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cdp_endpoints" ADD COLUMN "last_acquired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cdp_endpoints" ADD CONSTRAINT "cdp_endpoints_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cdp_endpoints_workflow_position_idx" ON "cdp_endpoints" USING btree ("workflow_id","position");