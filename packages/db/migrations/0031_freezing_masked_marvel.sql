CREATE TABLE "payment_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"paddle_transaction_id" text,
	"price_id" text NOT NULL,
	"credit_units" bigint NOT NULL,
	"refunded_units" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"checkout_url" text,
	"total_minor" bigint,
	"currency_code" text,
	"last_error" text,
	"credited_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_purchases_status_check" CHECK ("payment_purchases"."status" in ('creating','pending','completed','failed','partially_refunded','refunded')),
	CONSTRAINT "payment_purchases_credit_units_check" CHECK ("payment_purchases"."credit_units" > 0),
	CONSTRAINT "payment_purchases_refunded_units_check" CHECK ("payment_purchases"."refunded_units" >= 0 and "payment_purchases"."refunded_units" <= "payment_purchases"."credit_units"),
	CONSTRAINT "payment_purchases_total_check" CHECK ("payment_purchases"."total_minor" is null or "payment_purchases"."total_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_purchases" ADD CONSTRAINT "payment_purchases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_purchases_account_operation_key" ON "payment_purchases" USING btree ("account_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_purchases_transaction_key" ON "payment_purchases" USING btree ("paddle_transaction_id") WHERE "payment_purchases"."paddle_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_purchases_account_created_idx" ON "payment_purchases" USING btree ("account_id","created_at");