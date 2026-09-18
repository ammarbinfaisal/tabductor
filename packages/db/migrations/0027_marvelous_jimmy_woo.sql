CREATE TABLE "browser_recording_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"status" text NOT NULL,
	"object_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_recording_segments_time_check" CHECK ("browser_recording_segments"."start_ms" >= 0 and "browser_recording_segments"."end_ms" > "browser_recording_segments"."start_ms"),
	CONSTRAINT "browser_recording_segments_status_check" CHECK ("browser_recording_segments"."status" in ('ready','gap','private')),
	CONSTRAINT "browser_recording_segments_object_check" CHECK (("browser_recording_segments"."status" = 'ready' and "browser_recording_segments"."object_ref" is not null) or ("browser_recording_segments"."status" <> 'ready' and "browser_recording_segments"."object_ref" is null))
);
--> statement-breakpoint
CREATE TABLE "browser_session_activity" (
	"cursor" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"offset_ms" integer DEFAULT 0 NOT NULL,
	"page_id" text,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_session_activity_offset_check" CHECK ("browser_session_activity"."offset_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN "pause_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN "pause_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN "takeover_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN "recording_status" text DEFAULT 'unavailable' NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN "recording_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN "recording_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_recording_segments" ADD CONSTRAINT "browser_recording_segments_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_session_activity" ADD CONSTRAINT "browser_session_activity_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_recording_segments_session_sequence_key" ON "browser_recording_segments" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "browser_recording_segments_session_time_idx" ON "browser_recording_segments" USING btree ("session_id","start_ms");--> statement-breakpoint
CREATE INDEX "browser_session_activity_session_cursor_idx" ON "browser_session_activity" USING btree ("session_id","cursor");--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_recording_status_check" CHECK ("browser_sessions"."recording_status" in ('unavailable','recording','partial','complete','expired'));