CREATE TABLE "action_summaries" (
	"run_id" text NOT NULL,
	"call_id" text NOT NULL,
	"account_id" text NOT NULL,
	"source" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_summaries_run_id_call_id_pk" PRIMARY KEY("run_id","call_id")
);
--> statement-breakpoint
CREATE TABLE "billing_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_coupons" (
	"code" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"amount" text NOT NULL,
	"max_redemptions" integer,
	"expires_at" timestamp with time zone,
	"disabled" boolean DEFAULT false NOT NULL,
	"paddle_id" text,
	"sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"item" text NOT NULL,
	"charge_micros" bigint NOT NULL,
	"cost_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_rates_amount_check" CHECK ("billing_rates"."charge_micros" >= 0 and ("billing_rates"."cost_micros" is null or "billing_rates"."cost_micros" >= 0))
);
--> statement-breakpoint
CREATE TABLE "billing_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"code" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_code_account_id_pk" PRIMARY KEY("code","account_id")
);
--> statement-breakpoint
CREATE TABLE "operating_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"category" text NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"source_id" text NOT NULL,
	"cost_micros" bigint,
	"quantity" text DEFAULT '1' NOT NULL,
	"rate_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxy_accounts" (
	"hash" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_deletions" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"status" text DEFAULT 'stopping' NOT NULL,
	"error" text,
	"blob_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_billing" ALTER COLUMN "units_per_minute" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "captcha_jobs" ALTER COLUMN "credit_units" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "challenge_attempts" ALTER COLUMN "credit_units" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "money_unit" text DEFAULT 'usd_micro' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "deleting_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "action_summaries" ADD CONSTRAINT "action_summaries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_code_billing_coupons_code_fk" FOREIGN KEY ("code") REFERENCES "public"."billing_coupons"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_rates_lookup_idx" ON "billing_rates" USING btree ("category","provider","item","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_costs_source_key" ON "operating_costs" USING btree ("category","source_id");--> statement-breakpoint
CREATE INDEX "operating_costs_date_idx" ON "operating_costs" USING btree ("occurred_at");
--> statement-breakpoint
-- Existing numbers are legacy credits, never silently reinterpret them as dollars.
UPDATE accounts SET money_unit='legacy_credit' WHERE
 EXISTS (SELECT 1 FROM credit_ledger_entries l WHERE l.account_id=accounts.id) OR
 EXISTS (SELECT 1 FROM credit_reservations r WHERE r.account_id=accounts.id) OR
 EXISTS (SELECT 1 FROM payment_purchases p WHERE p.account_id=accounts.id);
--> statement-breakpoint
CREATE FUNCTION guard_deleting_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deleting timestamptz;
BEGIN
 IF TG_TABLE_NAME IN ('workflow_versions','workflow_shares') THEN
   SELECT deleting_at INTO deleting FROM workflows WHERE id=NEW.workflow_id FOR SHARE;
 ELSIF TG_TABLE_NAME='schedules' THEN
   IF NOT NEW.enabled THEN RETURN NEW; END IF;
   SELECT w.deleting_at INTO deleting FROM workflows w JOIN workflow_versions v ON v.workflow_id=w.id JOIN tasks t ON t.workflow_version_id=v.id WHERE t.id=NEW.task_id FOR SHARE OF w;
 ELSE
   SELECT w.deleting_at INTO deleting FROM workflows w JOIN workflow_versions v ON v.workflow_id=w.id WHERE v.id=NEW.workflow_version_id FOR SHARE OF w;
 END IF;
 IF deleting IS NOT NULL THEN RAISE EXCEPTION 'Workflow is being deleted' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_deletion_guard BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION guard_deleting_workflow();
--> statement-breakpoint
CREATE TRIGGER versions_deletion_guard BEFORE INSERT ON workflow_versions FOR EACH ROW EXECUTE FUNCTION guard_deleting_workflow();
--> statement-breakpoint
CREATE TRIGGER shares_deletion_guard BEFORE INSERT ON workflow_shares FOR EACH ROW EXECUTE FUNCTION guard_deleting_workflow();
--> statement-breakpoint
CREATE TRIGGER schedules_deletion_guard BEFORE INSERT OR UPDATE ON schedules FOR EACH ROW EXECUTE FUNCTION guard_deleting_workflow();
