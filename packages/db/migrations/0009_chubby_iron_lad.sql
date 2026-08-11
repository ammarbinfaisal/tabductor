CREATE TABLE "cdp_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	-- TODO S7: encrypt. Plaintext is acceptable this phase only because the product is single-user local (§16 Threat 5).
	"ws_url" text NOT NULL,
	"label" text,
	"healthy" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"max_queue_depth" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_leases" (
	"endpoint_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "endpoint_leases" ADD CONSTRAINT "endpoint_leases_endpoint_id_cdp_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."cdp_endpoints"("id") ON DELETE cascade ON UPDATE no action;