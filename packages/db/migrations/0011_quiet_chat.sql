CREATE TABLE "secret_access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"secret_name" text NOT NULL,
	"action" text NOT NULL,
	"anchor" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_grants" (
	"task_id" text NOT NULL,
	"secret_name" text NOT NULL,
	CONSTRAINT "secret_grants_task_id_secret_name_pk" PRIMARY KEY("task_id","secret_name")
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tier" text DEFAULT 'server' NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"dek_wrapped" text NOT NULL,
	"kek_ref" text NOT NULL,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "secrets_tier_check" CHECK ("secrets"."tier" in ('server','user_wrapped'))
);
--> statement-breakpoint
ALTER TABLE "secret_access_log" ADD CONSTRAINT "secret_access_log_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_grants" ADD CONSTRAINT "secret_grants_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_access_log_run_idx" ON "secret_access_log" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_user_name_key" ON "secrets" USING btree ("user_id","name");