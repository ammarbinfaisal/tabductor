CREATE TABLE "payment_adjustments" (
	"paddle_adjustment_id" text PRIMARY KEY NOT NULL,
	"purchase_id" text NOT NULL,
	"paddle_transaction_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"debited_units" bigint DEFAULT 0 NOT NULL,
	"last_event_id" text NOT NULL,
	"last_occurred_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_adjustments_action_check" CHECK ("payment_adjustments"."action" in ('refund','credit','chargeback')),
	CONSTRAINT "payment_adjustments_status_check" CHECK ("payment_adjustments"."status" in ('pending_approval','approved','rejected')),
	CONSTRAINT "payment_adjustments_amount_check" CHECK ("payment_adjustments"."amount_minor" > 0),
	CONSTRAINT "payment_adjustments_debited_check" CHECK ("payment_adjustments"."debited_units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payment_adjustments" ADD CONSTRAINT "payment_adjustments_purchase_id_payment_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."payment_purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_adjustments_purchase_idx" ON "payment_adjustments" USING btree ("purchase_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_adjustments_transaction_idx" ON "payment_adjustments" USING btree ("paddle_transaction_id");