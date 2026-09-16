CREATE TABLE "compile_reports" (
	"workflow_version_id" text PRIMARY KEY NOT NULL,
	"report_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposed_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_version_id" text NOT NULL,
	"task_ref" text NOT NULL,
	"grant_key" text NOT NULL,
	"grant_value" text NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposed_grants_status_check" CHECK ("proposed_grants"."status" in ('pending','approved','rejected','stripped_by_baseline'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "content_basis_hash" text;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "store_schema_id" text;--> statement-breakpoint
ALTER TABLE "compile_reports" ADD CONSTRAINT "compile_reports_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_grants" ADD CONSTRAINT "proposed_grants_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposed_grants_version_idx" ON "proposed_grants" USING btree ("workflow_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposed_grants_identity_key" ON "proposed_grants" USING btree ("workflow_version_id","task_ref","grant_key","grant_value");--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_store_schema_id_store_schemas_id_fk" FOREIGN KEY ("store_schema_id") REFERENCES "public"."store_schemas"("id") ON DELETE set null ON UPDATE no action;