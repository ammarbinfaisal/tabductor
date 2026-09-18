CREATE TABLE "browser_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"account_id" text NOT NULL,
	"identity" text NOT NULL,
	"kind" text NOT NULL,
	"website_url" text NOT NULL,
	"site_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_task_id" text,
	"rate_version" text NOT NULL,
	"credit_units" integer NOT NULL,
	"reservation_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD CONSTRAINT "browser_challenges_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD CONSTRAINT "browser_challenges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_attempts" ADD CONSTRAINT "challenge_attempts_challenge_id_browser_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."browser_challenges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_attempts" ADD CONSTRAINT "challenge_attempts_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_challenges_identity_key" ON "browser_challenges" USING btree ("session_id","identity");--> statement-breakpoint
CREATE INDEX "challenge_attempts_challenge_idx" ON "challenge_attempts" USING btree ("challenge_id");