CREATE TABLE "payment_webhook_events" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload_sha256" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_webhook_events_status_check" CHECK ("payment_webhook_events"."status" in ('received','pending','processed','failed')),
	CONSTRAINT "payment_webhook_events_attempts_check" CHECK ("payment_webhook_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_events_event_key" ON "payment_webhook_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "payment_webhook_events_status_created_idx" ON "payment_webhook_events" USING btree ("status","created_at");