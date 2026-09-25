ALTER TABLE "payment_purchases" DROP CONSTRAINT "payment_purchases_total_check";--> statement-breakpoint
ALTER TABLE "operating_costs" ADD COLUMN "status" text DEFAULT 'settled' NOT NULL;--> statement-breakpoint
ALTER TABLE "operating_costs" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "payment_purchases" ADD COLUMN "discount_id" text;--> statement-breakpoint
ALTER TABLE "payment_purchases" ADD COLUMN "financial_json" jsonb;--> statement-breakpoint
ALTER TABLE "payment_purchases" ADD CONSTRAINT "payment_purchases_total_check" CHECK ("payment_purchases"."total_minor" is null or "payment_purchases"."total_minor" >= 0);