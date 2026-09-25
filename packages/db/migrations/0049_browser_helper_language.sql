ALTER TABLE "browser_helpers" ADD COLUMN "language" text NOT NULL DEFAULT 'javascript';
--> statement-breakpoint
ALTER TABLE "browser_helpers" ADD CONSTRAINT "browser_helpers_language_check" CHECK ("language" IN ('javascript', 'python'));
