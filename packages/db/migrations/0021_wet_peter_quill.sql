CREATE TABLE "account_baseline_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"rule_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"check" text NOT NULL,
	"rule" text NOT NULL,
	"request_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_grants" (
	"task_id" text NOT NULL,
	"grant_key" text NOT NULL,
	"grant_value" text NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_grants_task_id_grant_key_grant_value_pk" PRIMARY KEY("task_id","grant_key","grant_value")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_grants" ADD CONSTRAINT "task_grants_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_baseline_rules_user_idx" ON "account_baseline_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "approvals_run_idx" ON "approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "approvals_pending_expiry_idx" ON "approvals" USING btree ("expires_at") WHERE "approvals"."status" = 'pending';