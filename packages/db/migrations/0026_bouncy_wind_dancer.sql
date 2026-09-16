CREATE TABLE "browser_allocation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_allocation_requests_status_check" CHECK ("browser_allocation_requests"."status" in ('queued','claimed','fulfilled','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "browser_profile_leases" (
	"profile_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"generation" integer NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"snapshot_blob_ref" text,
	"snapshot_generation" integer DEFAULT 0 NOT NULL,
	"fingerprint_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proxy_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"execution_id" text,
	"profile_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"worker_id" text,
	"pod_name" text,
	"input_owner" text DEFAULT 'ai' NOT NULL,
	"input_owner_generation" integer DEFAULT 1 NOT NULL,
	"ready_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_sessions_status_check" CHECK ("browser_sessions"."status" in ('queued','allocating','ready','running','stopping','ended','failed')),
	CONSTRAINT "browser_sessions_input_owner_check" CHECK ("browser_sessions"."input_owner" in ('ai','human','paused'))
);
--> statement-breakpoint
CREATE TABLE "browser_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"pod_name" text NOT NULL,
	"status" text DEFAULT 'warm' NOT NULL,
	"session_id" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_workers_status_check" CHECK ("browser_workers"."status" in ('warm','allocated','draining','dead'))
);
--> statement-breakpoint
ALTER TABLE "browser_allocation_requests" ADD CONSTRAINT "browser_allocation_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_allocation_requests" ADD CONSTRAINT "browser_allocation_requests_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profile_leases" ADD CONSTRAINT "browser_profile_leases_profile_id_browser_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."browser_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profile_leases" ADD CONSTRAINT "browser_profile_leases_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_profile_id_browser_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."browser_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_workers" ADD CONSTRAINT "browser_workers_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_allocation_requests_session_key" ON "browser_allocation_requests" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "browser_allocation_requests_queue_idx" ON "browser_allocation_requests" USING btree ("status","not_before","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_profiles_account_name_key" ON "browser_profiles" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX "browser_profiles_account_idx" ON "browser_profiles" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "browser_sessions_account_created_idx" ON "browser_sessions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "browser_sessions_status_idx" ON "browser_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_workers_pod_key" ON "browser_workers" USING btree ("pod_name");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_workers_live_session_key" ON "browser_workers" USING btree ("session_id") WHERE "browser_workers"."session_id" is not null and "browser_workers"."status" = 'allocated';--> statement-breakpoint
CREATE INDEX "browser_workers_status_idx" ON "browser_workers" USING btree ("status");