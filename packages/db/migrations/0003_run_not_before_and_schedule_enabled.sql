ALTER TABLE "runs" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_queued_idx" ON "runs" USING btree ("status","not_before");