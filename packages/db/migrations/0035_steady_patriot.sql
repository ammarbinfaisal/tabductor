CREATE TABLE "browser_billing" (
	"session_id" text PRIMARY KEY NOT NULL,
	"reservation_id" text NOT NULL,
	"rate_version" text NOT NULL,
	"units_per_minute" integer NOT NULL,
	"max_seconds" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "browser_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"run_id" text,
	"run_generation" integer,
	"generation" integer NOT NULL,
	"input_generation" integer NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_browser_profiles" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_billing" ADD CONSTRAINT "browser_billing_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_billing" ADD CONSTRAINT "browser_billing_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_commands" ADD CONSTRAINT "browser_commands_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_commands" ADD CONSTRAINT "browser_commands_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_browser_profiles" ADD CONSTRAINT "workflow_browser_profiles_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_browser_profiles" ADD CONSTRAINT "workflow_browser_profiles_profile_id_browser_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."browser_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_commands_session_idx" ON "browser_commands" USING btree ("session_id","created_at");