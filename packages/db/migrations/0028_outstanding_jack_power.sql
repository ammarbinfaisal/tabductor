CREATE TABLE "credit_ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"reservation_id" text,
	"kind" text NOT NULL,
	"units" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_entries_kind_check" CHECK ("credit_ledger_entries"."kind" in ('purchase','adjustment','refund','reservation_hold','reservation_release','reservation_settlement')),
	CONSTRAINT "credit_ledger_entries_units_check" CHECK ("credit_ledger_entries"."units" <> 0)
);
--> statement-breakpoint
CREATE TABLE "credit_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"category" text NOT NULL,
	"reserved_units" bigint NOT NULL,
	"settled_units" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_reservations_status_check" CHECK ("credit_reservations"."status" in ('active','settled','released','expired')),
	CONSTRAINT "credit_reservations_category_check" CHECK ("credit_reservations"."category" in ('browser','model','proxy','solver','other')),
	CONSTRAINT "credit_reservations_reserved_check" CHECK ("credit_reservations"."reserved_units" > 0),
	CONSTRAINT "credit_reservations_settled_check" CHECK ("credit_reservations"."settled_units" is null or ("credit_reservations"."settled_units" >= 0 and "credit_reservations"."settled_units" <= "credit_reservations"."reserved_units"))
);
--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_entries_idempotency_key" ON "credit_ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_entries_account_created_idx" ON "credit_ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_entries_reservation_idx" ON "credit_ledger_entries" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservations_account_operation_key" ON "credit_reservations" USING btree ("account_id","operation_id");--> statement-breakpoint
CREATE INDEX "credit_reservations_active_expiry_idx" ON "credit_reservations" USING btree ("status","expires_at");
