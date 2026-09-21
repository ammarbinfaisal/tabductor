CREATE TABLE "browser_fleet_status" (
	"id" text PRIMARY KEY NOT NULL,
	"max_allocated" integer NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
