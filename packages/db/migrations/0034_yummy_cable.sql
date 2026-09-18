CREATE TABLE "model_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"workflow_id" text,
	"run_id" text,
	"purpose" text NOT NULL,
	"funding" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"rate_version" text,
	"rate_json" jsonb,
	"reservation_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"input_tokens" integer,
	"cached_input_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"charged_units" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "model_operations_status_check" CHECK ("model_operations"."status" in ('pending','succeeded','uncertain'))
);
--> statement-breakpoint
CREATE TABLE "model_selections" (
	"account_id" text NOT NULL,
	"scope" text NOT NULL,
	"funding" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"credential_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_selections_account_id_scope_pk" PRIMARY KEY("account_id","scope"),
	CONSTRAINT "model_selections_funding_check" CHECK (("model_selections"."funding" = 'byo' and "model_selections"."credential_id" is not null) or ("model_selections"."funding" = 'platform' and "model_selections"."credential_id" is null))
);
--> statement-breakpoint
ALTER TABLE "model_credentials" ADD CONSTRAINT "model_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_operations" ADD CONSTRAINT "model_operations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_operations" ADD CONSTRAINT "model_operations_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_operations" ADD CONSTRAINT "model_operations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_operations" ADD CONSTRAINT "model_operations_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_selections" ADD CONSTRAINT "model_selections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_selections" ADD CONSTRAINT "model_selections_credential_id_model_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."model_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_credentials_account_idx" ON "model_credentials" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "model_operations_account_created_idx" ON "model_operations" USING btree ("account_id","created_at");