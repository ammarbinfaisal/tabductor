CREATE TABLE "captcha_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"run_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"provider" text NOT NULL,
	"task_type" text NOT NULL,
	"provider_task_id" text,
	"status" text NOT NULL,
	"solution_json" jsonb,
	"error_code" text,
	"rate_version" text NOT NULL,
	"credit_units" integer NOT NULL,
	"reservation_id" text NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "captcha_jobs" ADD CONSTRAINT "captcha_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captcha_jobs" ADD CONSTRAINT "captcha_jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captcha_jobs" ADD CONSTRAINT "captcha_jobs_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "captcha_jobs_run_key" ON "captcha_jobs" USING btree ("run_id","idempotency_key");