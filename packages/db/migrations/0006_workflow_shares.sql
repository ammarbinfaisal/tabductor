CREATE TABLE "workflow_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"token_sha256" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "event_defs" ADD COLUMN "public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_shares" ADD CONSTRAINT "workflow_shares_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_shares_token_key" ON "workflow_shares" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "workflow_shares_workflow_idx" ON "workflow_shares" USING btree ("workflow_id");