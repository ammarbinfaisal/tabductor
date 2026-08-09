ALTER TABLE "events" ADD COLUMN "traceparent" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "traceparent" text;