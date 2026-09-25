ALTER TABLE "accounts" ADD COLUMN "legacy_credit_micros" bigint;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD COLUMN "money_unit" text DEFAULT 'legacy_credit' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ALTER COLUMN "money_unit" SET DEFAULT 'usd_micro';
